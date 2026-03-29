// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.30;

import {CatalogRegistry, ISessionKeyRegistry} from "../src/CatalogRegistry.sol";

contract MockSessionKeyRegistry is ISessionKeyRegistry {
    mapping(address user => mapping(address signer => mapping(bytes32 permission => uint256))) public expiry;

    function setExpiry(address user, address signer, bytes32 permission, uint256 value) external {
        expiry[user][signer][permission] = value;
    }

    function authorizationExpiry(address user, address signer, bytes32 permission) external view returns (uint256) {
        return expiry[user][signer][permission];
    }
}

contract Caller {
    function add(
        CatalogRegistry registry,
        address claimedUser,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title
    ) external returns (uint256) {
        return registry.addEntry(claimedUser, assetId, providerId, manifestCid, title);
    }

    function del(CatalogRegistry registry, address claimedUser, uint256 entryId) external {
        registry.deleteEntry(claimedUser, entryId);
    }
}

contract CatalogRegistryTest {
    MockSessionKeyRegistry private sk;
    CatalogRegistry private registry;
    Caller private creator;
    Caller private sessionSigner;
    Caller private other;

    bytes32 private constant PERM_ADD = keccak256("FILSTREAM_CATALOG_ADD_V1");
    bytes32 private constant PERM_DELETE = keccak256("FILSTREAM_CATALOG_DELETE_V1");

    function setUp() public {
        sk = new MockSessionKeyRegistry();
        registry = new CatalogRegistry(address(this), address(sk), PERM_ADD, PERM_DELETE);
        creator = new Caller();
        sessionSigner = new Caller();
        other = new Caller();
    }

    function test_directCreatorAddAndDelete() public {
        uint256 entryId = creator.add(registry, address(creator), "asset_1", 4, "bafy-manifest-1", "Video 1");
        assert(entryId == 1);

        CatalogRegistry.Entry memory e = registry.getEntry(entryId);
        assert(e.entryId == 1);
        assert(e.creator == address(creator));
        assert(e.active == true);

        creator.del(registry, address(creator), entryId);
        e = registry.getEntry(entryId);
        assert(e.active == false);
    }

    function test_sessionSignerAuthorizedAddAndDelete() public {
        sk.setExpiry(address(creator), address(sessionSigner), PERM_ADD, block.timestamp + 1 hours);
        sk.setExpiry(address(creator), address(sessionSigner), PERM_DELETE, block.timestamp + 1 hours);

        uint256 entryId = sessionSigner.add(registry, address(creator), "asset_2", 4, "bafy-manifest-2", "Video 2");
        CatalogRegistry.Entry memory e = registry.getEntry(entryId);
        assert(e.creator == address(creator));
        assert(e.active == true);

        sessionSigner.del(registry, address(creator), entryId);
        e = registry.getEntry(entryId);
        assert(e.active == false);
    }

    function test_sessionSignerWithoutAuthorizationReverts() public {
        bool addReverted = false;
        try sessionSigner.add(registry, address(creator), "asset_3", 4, "bafy-manifest-3", "Video 3") returns (uint256)
        {
            addReverted = false;
        } catch {
            addReverted = true;
        }
        assert(addReverted);
    }

    function test_deleteByWrongUserReverts() public {
        uint256 entryId = creator.add(registry, address(creator), "asset_4", 4, "bafy-manifest-4", "Video 4");
        bool delReverted = false;
        try other.del(registry, address(other), entryId) {
            delReverted = false;
        } catch {
            delReverted = true;
        }
        assert(delReverted);
    }

    function test_ownerOverrideCanUpdateAndDelete() public {
        uint256 entryId = creator.add(registry, address(creator), "asset_5", 4, "bafy-manifest-5", "Video 5");

        registry.ownerUpdateEntry(entryId, address(other), "asset_5b", 9, "bafy-manifest-5b", "Video 5B", true);

        CatalogRegistry.Entry memory e = registry.getEntry(entryId);
        assert(e.creator == address(other));
        assert(e.providerId == 9);
        assert(keccak256(bytes(e.assetId)) == keccak256(bytes("asset_5b")));
        assert(keccak256(bytes(e.manifestCid)) == keccak256(bytes("bafy-manifest-5b")));
        assert(keccak256(bytes(e.title)) == keccak256(bytes("Video 5B")));
        assert(e.active == true);

        registry.ownerDeleteEntry(entryId);
        e = registry.getEntry(entryId);
        assert(e.active == false);
    }

    function test_getLatestAndGetNewerThan() public {
        uint256 e1 = creator.add(registry, address(creator), "asset_a", 4, "cid_a", "A");
        uint64 t1 = registry.getEntry(e1).createdAt;
        uint256 e2 = creator.add(registry, address(creator), "asset_b", 4, "cid_b", "B");
        uint256 e3 = creator.add(registry, address(creator), "asset_c", 4, "cid_c", "C");

        CatalogRegistry.Entry[] memory latest = registry.getLatest(0, 2, true);
        assert(latest.length == 2);
        assert(latest[0].entryId == e3);
        assert(latest[1].entryId == e2);

        CatalogRegistry.Entry[] memory newer = registry.getNewerThan(t1, e1, 10, true);
        assert(newer.length == 2);
        assert(newer[0].entryId == e2);
        assert(newer[1].entryId == e3);
    }

    function test_pauseBlocksUserMutations() public {
        registry.setPaused(true);
        bool addReverted = false;
        try creator.add(registry, address(creator), "asset_paused", 4, "cid_paused", "Paused") returns (uint256) {
            addReverted = false;
        } catch {
            addReverted = true;
        }
        assert(addReverted);

        registry.setPaused(false);
        uint256 entryId = creator.add(registry, address(creator), "asset_ok", 4, "cid_ok", "Ok");
        assert(entryId == 1);
    }

    function test_profilePictureSetAndOwnerOverride() public {
        registry.setMyProfilePicturePieceCid("bafy-profile-1");
        string memory direct = registry.profilePicturePieceCidOf(address(this));
        assert(keccak256(bytes(direct)) == keccak256(bytes("bafy-profile-1")));

        registry.ownerSetProfilePicturePieceCid(address(creator), "bafy-profile-2");
        string memory ownerSet = registry.profilePicturePieceCidOf(address(creator));
        assert(keccak256(bytes(ownerSet)) == keccak256(bytes("bafy-profile-2")));
    }
}
