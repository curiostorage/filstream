// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.30;

interface Vm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function addr(uint256 privateKey) external returns (address);
}

interface IOldCatalogRegistry {
    struct Entry {
        uint256 entryId;
        uint64 createdAt;
        uint64 updatedAt;
        address creator;
        string assetId;
        uint64 providerId;
        string manifestCid;
        string title;
        bool active;
    }

    function totalEntries() external view returns (uint256);
    function getLatest(uint256 offset, uint256 limit, bool activeOnly) external view returns (Entry[] memory out);
    function usernameOf(address user) external view returns (string memory);
}

interface INewCatalogRegistry {
    struct Entry {
        uint256 entryId;
        uint64 createdAt;
        uint64 updatedAt;
        address creator;
        string assetId;
        uint64 providerId;
        string manifestCid;
        string title;
        bool active;
    }

    function owner() external view returns (address);
    function nextEntryId() external view returns (uint256);
    function usernameOf(address user) external view returns (string memory);

    function ownerCreateEntry(
        address creator,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title,
        bool active
    ) external returns (uint256 entryId);

    function addEntry(
        address claimedUser,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title
    ) external returns (uint256 entryId);

    function deleteEntry(address claimedUser, uint256 entryId) external;
    function ownerSetUsername(address user, string calldata username) external;
    function setMyUsername(string calldata username) external;
    function setMyProfilePicturePieceCid(string calldata pieceCid) external;
}

contract MigrateCatalogScript {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    mapping(address creator => bool copied) private _usernameCopied;

    /// @notice Migrate old catalog data into the new catalog contract.
    /// @dev If broadcaster is new contract owner: migrates all entries/usernames.
    ///      Otherwise migrates only broadcaster's entries/username.
    /// @param oldCatalog Address of old contract (without profile-picture mapping).
    /// @param newCatalog Address of new contract.
    /// @param privateKey Signer key used for broadcasting (owner/deployer or creator).
    /// @param pageSize Old catalog page size (100 recommended).
    /// @param creatorProfilePieceCid Optional profile picture CID for creator mode only.
    function run(
        address oldCatalog,
        address newCatalog,
        uint256 privateKey,
        uint256 pageSize,
        string calldata creatorProfilePieceCid
    ) external {
        require(oldCatalog != address(0) && newCatalog != address(0), "zero contract address");
        require(pageSize > 0, "invalid pageSize");

        IOldCatalogRegistry oldRegistry = IOldCatalogRegistry(oldCatalog);
        INewCatalogRegistry nextRegistry = INewCatalogRegistry(newCatalog);

        address signer = vm.addr(privateKey);
        bool ownerMode = signer == nextRegistry.owner();

        vm.startBroadcast(privateKey);

        if (!ownerMode) {
            _copyCreatorUsername(oldRegistry, nextRegistry, signer, signer, false);
            _setCreatorProfilePictureIfNeeded(nextRegistry, creatorProfilePieceCid);
        }

        _migrateEntries(oldRegistry, nextRegistry, signer, ownerMode, pageSize);

        vm.stopBroadcast();
    }

    function _migrateEntries(
        IOldCatalogRegistry oldRegistry,
        INewCatalogRegistry nextRegistry,
        address signer,
        bool ownerMode,
        uint256 pageSize
    ) internal {
        uint256 total = oldRegistry.totalEntries();
        if (total == 0) return;
        uint256 ownerSkipCount = ownerMode ? nextRegistry.nextEntryId() - 1 : 0;
        uint256 ownerSeenCount = 0;

        uint256 remaining = total;
        while (remaining > 0) {
            uint256 chunk = remaining > pageSize ? pageSize : remaining;
            uint256 offset = remaining - chunk;
            IOldCatalogRegistry.Entry[] memory page = oldRegistry.getLatest(offset, chunk, false);
            uint256 n = page.length;
            if (n == 0) break;

            // Process oldest -> newest within each chunk.
            for (uint256 i = n; i > 0; i--) {
                IOldCatalogRegistry.Entry memory e = page[i - 1];
                if (ownerMode && ownerSeenCount < ownerSkipCount) {
                    ownerSeenCount += 1;
                    continue;
                }
                if (!ownerMode && e.creator != signer) {
                    continue;
                }
                _migrateSingleEntry(oldRegistry, nextRegistry, signer, ownerMode, e);
            }
            remaining = offset;
        }
    }

    function _migrateSingleEntry(
        IOldCatalogRegistry oldRegistry,
        INewCatalogRegistry nextRegistry,
        address signer,
        bool ownerMode,
        IOldCatalogRegistry.Entry memory e
    ) internal {
        if (ownerMode) {
            _copyCreatorUsername(oldRegistry, nextRegistry, e.creator, signer, true);
            nextRegistry.ownerCreateEntry(
                e.creator,
                e.assetId,
                e.providerId,
                e.manifestCid,
                e.title,
                e.active
            );
            return;
        }

        uint256 nextEntryId = nextRegistry.nextEntryId();
        nextRegistry.addEntry(signer, e.assetId, e.providerId, e.manifestCid, e.title);
        if (!e.active) {
            nextRegistry.deleteEntry(signer, nextEntryId);
        }
    }

    function _copyCreatorUsername(
        IOldCatalogRegistry oldRegistry,
        INewCatalogRegistry nextRegistry,
        address creator,
        address signer,
        bool ownerMode
    ) internal {
        if (_usernameCopied[creator]) return;
        _usernameCopied[creator] = true;

        string memory oldName = oldRegistry.usernameOf(creator);
        if (bytes(oldName).length == 0) return;

        string memory newName = nextRegistry.usernameOf(creator);
        if (_sameString(oldName, newName)) return;

        if (ownerMode) {
            nextRegistry.ownerSetUsername(creator, oldName);
            return;
        }
        if (creator == signer) {
            nextRegistry.setMyUsername(oldName);
        }
    }

    function _setCreatorProfilePictureIfNeeded(
        INewCatalogRegistry nextRegistry,
        string calldata creatorProfilePieceCid
    ) internal {
        if (bytes(creatorProfilePieceCid).length == 0) return;
        // Profile picture does not exist in the old catalog; only write when explicitly provided.
        nextRegistry.setMyProfilePicturePieceCid(creatorProfilePieceCid);
    }

    function _sameString(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
