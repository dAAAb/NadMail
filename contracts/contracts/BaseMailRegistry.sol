// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BaseMailRegistry
 * @notice Base 鏈上的 AI Agent Email 身份註冊表
 * @dev 記錄錢包地址與 @basemail.ai handle 的映射關係
 *
 * 鏈上只儲存映射關係（身份證明），實際郵件收發由 Cloudflare Workers 處理。
 * 這確保了：
 * - 身份可驗證（任何人可查詢鏈上記錄）
 * - 成本極低（只寫一次鏈上）
 * - 郵件處理高效（Cloudflare 邊緣網路）
 */
contract BaseMailRegistry {
    // ──────────────────────────────────────────────
    // 狀態變數
    // ──────────────────────────────────────────────

    address public owner;
    bool public paused;

    /// @notice 錢包地址 → email handle
    mapping(address => string) public emailOf;

    /// @notice handle → 錢包地址（反向查詢）
    mapping(string => address) public ownerOf;

    /// @notice handle 是否已被註冊
    mapping(string => bool) public taken;

    /// @notice 已註冊總數
    uint256 public totalRegistrations;

    // ──────────────────────────────────────────────
    // 事件
    // ──────────────────────────────────────────────

    event EmailRegistered(
        address indexed wallet,
        string handle,
        string email
    );

    event EmailTransferred(
        string handle,
        address indexed from,
        address indexed to
    );

    event EmailReleased(
        address indexed wallet,
        string handle
    );

    // ──────────────────────────────────────────────
    // 修飾器
    // ──────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract paused");
        _;
    }

    // ──────────────────────────────────────────────
    // 建構函式
    // ──────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ──────────────────────────────────────────────
    // 核心功能
    // ──────────────────────────────────────────────

    /**
     * @notice 註冊一個 @basemail.ai email handle
     * @param handle 想要的 email 名稱（例如 "myagent"）
     * @dev handle 必須是 3-32 個字元，只允許小寫字母、數字、- 和 _
     */
    function register(string calldata handle) external whenNotPaused {
        require(!taken[handle], "Handle already taken");
        require(bytes(emailOf[msg.sender]).length == 0, "Wallet already registered");
        require(_validHandle(handle), "Invalid handle format");

        emailOf[msg.sender] = handle;
        ownerOf[handle] = msg.sender;
        taken[handle] = true;
        totalRegistrations++;

        emit EmailRegistered(
            msg.sender,
            handle,
            string.concat(handle, "@basemail.ai")
        );
    }

    /**
     * @notice 將 email handle 轉移給另一個錢包
     * @param handle 要轉移的 handle
     * @param to 接收者錢包地址
     */
    function transfer(string calldata handle, address to) external whenNotPaused {
        require(ownerOf[handle] == msg.sender, "Not handle owner");
        require(to != address(0), "Invalid recipient");
        require(bytes(emailOf[to]).length == 0, "Recipient already has email");

        delete emailOf[msg.sender];
        emailOf[to] = handle;
        ownerOf[handle] = to;

        emit EmailTransferred(handle, msg.sender, to);
    }

    /**
     * @notice 釋放自己的 email handle
     */
    function release() external {
        string memory handle = emailOf[msg.sender];
        require(bytes(handle).length > 0, "No email registered");

        delete emailOf[msg.sender];
        delete ownerOf[handle];
        taken[handle] = false;
        totalRegistrations--;

        emit EmailReleased(msg.sender, handle);
    }

    // ──────────────────────────────────────────────
    // 查詢功能
    // ──────────────────────────────────────────────

    /**
     * @notice 取得錢包的完整 email 地址
     * @param wallet 錢包地址
     * @return 完整 email（例如 "myagent@basemail.ai"）
     */
    function getEmail(address wallet) external view returns (string memory) {
        string memory handle = emailOf[wallet];
        require(bytes(handle).length > 0, "No email registered");
        return string.concat(handle, "@basemail.ai");
    }

    /**
     * @notice 檢查 handle 是否可用
     * @param handle 想查詢的 handle
     * @return 是否可用
     */
    function isAvailable(string calldata handle) external view returns (bool) {
        return !taken[handle] && _validHandle(handle);
    }

    // ──────────────────────────────────────────────
    // 管理功能
    // ──────────────────────────────────────────────

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid new owner");
        owner = newOwner;
    }

    // ──────────────────────────────────────────────
    // 內部功能
    // ──────────────────────────────────────────────

    /**
     * @dev 驗證 handle 格式
     * 規則：3-32 字元，只允許 a-z, 0-9, -, _
     * 不能以 - 或 _ 開頭/結尾
     */
    function _validHandle(string calldata h) internal pure returns (bool) {
        bytes memory b = bytes(h);
        if (b.length < 3 || b.length > 32) return false;

        // 首尾必須是字母或數字
        if (!_isAlphaNum(b[0]) || !_isAlphaNum(b[b.length - 1])) return false;

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (!_isAlphaNum(c) && c != 0x2D && c != 0x5F) {
                // 不是 a-z, 0-9, -, _
                return false;
            }
        }
        return true;
    }

    function _isAlphaNum(bytes1 c) internal pure returns (bool) {
        return (c >= 0x61 && c <= 0x7A) || // a-z
               (c >= 0x30 && c <= 0x39);    // 0-9
    }
}
