// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.30;

interface ISessionKeyRegistry {
    function authorizationExpiry(address user, address signer, bytes32 permission) external view returns (uint256);
}

contract CatalogRegistry {
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

    error Unauthorized();
    error InvalidAddress();
    error InvalidValue(string field);
    error EntryNotFound(uint256 entryId);
    error NotEntryOwner(uint256 entryId, address expectedOwner, address caller);
    error Paused();
    error NotPaused();

    event OwnerUpdated(address indexed previousOwner, address indexed nextOwner);
    event PauseUpdated(bool paused);
    event SessionKeyRegistryUpdated(address indexed previousRegistry, address indexed nextRegistry);
    event PermissionUpdated(
        bytes32 indexed previousAddPermission,
        bytes32 indexed nextAddPermission,
        bytes32 previousDeletePermission,
        bytes32 nextDeletePermission
    );

    event UsernameUpdated(address indexed user, string username, address indexed updatedBy);
    event ProfilePictureUpdated(address indexed user, string pieceCid, address indexed updatedBy);

    event EntryAdded(
        uint256 indexed entryId,
        address indexed creator,
        string assetId,
        uint64 providerId,
        string manifestCid,
        string title,
        bool ownerOverride
    );
    event EntryUpdated(
        uint256 indexed entryId,
        address indexed creator,
        string assetId,
        uint64 providerId,
        string manifestCid,
        string title,
        bool active
    );
    event EntryDeleted(uint256 indexed entryId, address indexed creator, address indexed deletedBy, bool ownerOverride);

    uint256 public nextEntryId = 1;
    address public owner;
    bool public paused;

    ISessionKeyRegistry public sessionKeyRegistry;
    bytes32 public permissionAddEntry;
    bytes32 public permissionDeleteEntry;

    mapping(uint256 => Entry) private _entries;
    mapping(address => uint256[]) private _creatorEntryIds;
    mapping(address => string) private _usernames;
    mapping(address => string) private _profilePicturePieceCids;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(
        address initialOwner,
        address initialSessionKeyRegistry,
        bytes32 addPermission,
        bytes32 deletePermission
    ) {
        if (initialOwner == address(0) || initialSessionKeyRegistry == address(0)) revert InvalidAddress();
        if (addPermission == bytes32(0) || deletePermission == bytes32(0)) {
            revert InvalidValue("permission");
        }
        owner = initialOwner;
        sessionKeyRegistry = ISessionKeyRegistry(initialSessionKeyRegistry);
        permissionAddEntry = addPermission;
        permissionDeleteEntry = deletePermission;
        emit OwnerUpdated(address(0), initialOwner);
        emit SessionKeyRegistryUpdated(address(0), initialSessionKeyRegistry);
        emit PermissionUpdated(bytes32(0), addPermission, bytes32(0), deletePermission);
    }

    function setOwner(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidAddress();
        address prev = owner;
        owner = nextOwner;
        emit OwnerUpdated(prev, nextOwner);
    }

    function setPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit PauseUpdated(isPaused);
    }

    function setSessionKeyRegistry(address nextRegistry) external onlyOwner {
        if (nextRegistry == address(0)) revert InvalidAddress();
        address prev = address(sessionKeyRegistry);
        sessionKeyRegistry = ISessionKeyRegistry(nextRegistry);
        emit SessionKeyRegistryUpdated(prev, nextRegistry);
    }

    function setPermissions(bytes32 nextAddPermission, bytes32 nextDeletePermission) external onlyOwner {
        if (nextAddPermission == bytes32(0) || nextDeletePermission == bytes32(0)) {
            revert InvalidValue("permission");
        }
        bytes32 prevAdd = permissionAddEntry;
        bytes32 prevDelete = permissionDeleteEntry;
        permissionAddEntry = nextAddPermission;
        permissionDeleteEntry = nextDeletePermission;
        emit PermissionUpdated(prevAdd, nextAddPermission, prevDelete, nextDeletePermission);
    }

    function setMyUsername(string calldata username) external {
        _usernames[msg.sender] = username;
        emit UsernameUpdated(msg.sender, username, msg.sender);
    }

    function ownerSetUsername(address user, string calldata username) external onlyOwner {
        if (user == address(0)) revert InvalidAddress();
        _usernames[user] = username;
        emit UsernameUpdated(user, username, msg.sender);
    }

    function usernameOf(address user) external view returns (string memory) {
        return _usernames[user];
    }

    function setMyProfilePicturePieceCid(string calldata pieceCid) external {
        _profilePicturePieceCids[msg.sender] = pieceCid;
        emit ProfilePictureUpdated(msg.sender, pieceCid, msg.sender);
    }

    function ownerSetProfilePicturePieceCid(address user, string calldata pieceCid) external onlyOwner {
        if (user == address(0)) revert InvalidAddress();
        _profilePicturePieceCids[user] = pieceCid;
        emit ProfilePictureUpdated(user, pieceCid, msg.sender);
    }

    function profilePicturePieceCidOf(address user) external view returns (string memory) {
        return _profilePicturePieceCids[user];
    }

    function addEntry(
        address claimedUser,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title
    ) external whenNotPaused returns (uint256 entryId) {
        address actor = _resolveActor(claimedUser, permissionAddEntry);
        entryId = _createEntry(actor, assetId, providerId, manifestCid, title);
        emit EntryAdded(entryId, actor, assetId, providerId, manifestCid, title, false);
    }

    function deleteEntry(address claimedUser, uint256 entryId) external whenNotPaused {
        address actor = _resolveActor(claimedUser, permissionDeleteEntry);
        Entry storage e = _entryStorage(entryId);
        if (e.creator != actor) revert NotEntryOwner(entryId, e.creator, actor);
        if (!e.active) revert InvalidValue("entry_inactive");
        e.active = false;
        e.updatedAt = uint64(block.timestamp);
        emit EntryDeleted(entryId, e.creator, msg.sender, false);
    }

    function ownerCreateEntry(
        address creator,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title,
        bool active
    ) external onlyOwner returns (uint256 entryId) {
        if (creator == address(0)) revert InvalidAddress();
        entryId = _createEntry(creator, assetId, providerId, manifestCid, title);
        if (!active) {
            Entry storage e = _entries[entryId];
            e.active = false;
            e.updatedAt = uint64(block.timestamp);
        }
        emit EntryAdded(entryId, creator, assetId, providerId, manifestCid, title, true);
    }

    function ownerUpdateEntry(
        uint256 entryId,
        address creator,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title,
        bool active
    ) external onlyOwner {
        if (creator == address(0)) revert InvalidAddress();
        _validateNewEntryFields(assetId, providerId, manifestCid, title);
        Entry storage e = _entryStorage(entryId);
        if (e.creator != creator) {
            _creatorEntryIds[creator].push(entryId);
        }
        e.creator = creator;
        e.assetId = assetId;
        e.providerId = providerId;
        e.manifestCid = manifestCid;
        e.title = title;
        e.active = active;
        e.updatedAt = uint64(block.timestamp);
        emit EntryUpdated(entryId, creator, assetId, providerId, manifestCid, title, active);
    }

    function ownerDeleteEntry(uint256 entryId) external onlyOwner {
        Entry storage e = _entryStorage(entryId);
        if (!e.active) revert InvalidValue("entry_inactive");
        e.active = false;
        e.updatedAt = uint64(block.timestamp);
        emit EntryDeleted(entryId, e.creator, msg.sender, true);
    }

    function totalEntries() external view returns (uint256) {
        return nextEntryId - 1;
    }

    function getEntry(uint256 entryId) external view returns (Entry memory) {
        return _entryMemory(entryId);
    }

    function getLatest(uint256 offset, uint256 limit, bool activeOnly) external view returns (Entry[] memory out) {
        if (limit == 0) return new Entry[](0);
        uint256 total = nextEntryId - 1;
        if (offset >= total) return new Entry[](0);

        Entry[] memory tmp = new Entry[](limit);
        uint256 count = 0;
        uint256 i = total - offset;
        while (i > 0 && count < limit) {
            Entry storage e = _entries[i];
            if (!activeOnly || e.active) {
                tmp[count] = _copy(e);
                count += 1;
            }
            unchecked {
                i -= 1;
            }
        }
        out = _trim(tmp, count);
    }

    function getNewerThan(uint64 cursorCreatedAt, uint256 cursorEntryId, uint256 limit, bool activeOnly)
        external
        view
        returns (Entry[] memory out)
    {
        if (limit == 0) return new Entry[](0);
        uint256 total = nextEntryId - 1;
        if (cursorEntryId >= total) return new Entry[](0);

        Entry[] memory tmp = new Entry[](limit);
        uint256 count = 0;
        uint256 i = total;
        while (i > cursorEntryId && count < limit) {
            Entry storage e = _entries[i];
            bool newerByTuple =
                e.createdAt > cursorCreatedAt || (e.createdAt == cursorCreatedAt && e.entryId > cursorEntryId);
            if (newerByTuple && (!activeOnly || e.active)) {
                tmp[count] = _copy(e);
                count += 1;
            }
            unchecked {
                i -= 1;
            }
        }

        // Reverse to chronological order (oldest to newest), easier for prepend/append UIs.
        out = new Entry[](count);
        for (uint256 j = 0; j < count; j++) {
            out[j] = tmp[count - 1 - j];
        }
    }

    function getByCreator(address creator, uint256 offset, uint256 limit, bool activeOnly)
        external
        view
        returns (Entry[] memory out)
    {
        if (creator == address(0)) revert InvalidAddress();
        if (limit == 0) return new Entry[](0);

        uint256[] storage ids = _creatorEntryIds[creator];
        if (ids.length == 0) return new Entry[](0);

        Entry[] memory tmp = new Entry[](limit);
        uint256 seen = 0;
        uint256 count = 0;

        uint256 idx = ids.length;
        while (idx > 0 && count < limit) {
            unchecked {
                idx -= 1;
            }
            Entry storage e = _entries[ids[idx]];
            if (e.creator != creator) continue; // stale index item from creator reassignment
            if (activeOnly && !e.active) continue;
            if (seen < offset) {
                seen += 1;
                continue;
            }
            tmp[count] = _copy(e);
            count += 1;
        }
        out = _trim(tmp, count);
    }

    function _createEntry(
        address creator,
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title
    ) internal returns (uint256 entryId) {
        if (creator == address(0)) revert InvalidAddress();
        _validateNewEntryFields(assetId, providerId, manifestCid, title);

        entryId = nextEntryId;
        nextEntryId = entryId + 1;

        Entry storage e = _entries[entryId];
        e.entryId = entryId;
        e.createdAt = uint64(block.timestamp);
        e.updatedAt = uint64(block.timestamp);
        e.creator = creator;
        e.assetId = assetId;
        e.providerId = providerId;
        e.manifestCid = manifestCid;
        e.title = title;
        e.active = true;

        _creatorEntryIds[creator].push(entryId);
    }

    function _resolveActor(address claimedUser, bytes32 permission) internal view returns (address actor) {
        if (claimedUser == address(0)) revert InvalidAddress();
        if (msg.sender == claimedUser) {
            return claimedUser;
        }
        uint256 expiry = sessionKeyRegistry.authorizationExpiry(claimedUser, msg.sender, permission);
        if (expiry < block.timestamp) revert Unauthorized();
        return claimedUser;
    }

    function _validateNewEntryFields(
        string calldata assetId,
        uint64 providerId,
        string calldata manifestCid,
        string calldata title
    ) internal pure {
        if (bytes(assetId).length == 0) revert InvalidValue("assetId");
        if (providerId == 0) revert InvalidValue("providerId");
        if (bytes(manifestCid).length == 0) revert InvalidValue("manifestCid");
        if (bytes(title).length == 0) revert InvalidValue("title");
    }

    function _entryStorage(uint256 entryId) internal view returns (Entry storage e) {
        e = _entries[entryId];
        if (e.entryId == 0) revert EntryNotFound(entryId);
    }

    function _entryMemory(uint256 entryId) internal view returns (Entry memory e) {
        Entry storage s = _entryStorage(entryId);
        e = _copy(s);
    }

    function _copy(Entry storage s) internal view returns (Entry memory e) {
        e = Entry({
            entryId: s.entryId,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            creator: s.creator,
            assetId: s.assetId,
            providerId: s.providerId,
            manifestCid: s.manifestCid,
            title: s.title,
            active: s.active
        });
    }

    function _trim(Entry[] memory arr, uint256 n) internal pure returns (Entry[] memory out) {
        out = new Entry[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = arr[i];
        }
    }
}
