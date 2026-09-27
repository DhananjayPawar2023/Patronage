// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ArtworkNFT
/// @notice One-of-one artwork collection controlled by an approved artist with EIP-712 Lazy Minting.
contract ArtworkNFT is ERC721URIStorage, ERC2981, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant VOUCHER_TYPEHASH = keccak256("NFTVoucher(address nft,uint256 tokenId,uint256 minPrice,string uri,address artist,uint256 nonce,uint256 deadline)");

    struct NFTVoucher {
        address nft;
        uint256 tokenId;
        uint256 minPrice;
        string uri;
        address artist;
        uint256 nonce;
        uint256 deadline;
    }

    uint256 public nextTokenId = 1;
    address public creator;
    bool public initialized;
    string private _customName;
    string private _customSymbol;

    mapping(bytes32 => bool) public redeemedVouchers;

    error InvalidCreator();
    error AlreadyInitialized();
    error InvalidVoucher();
    error InsufficientPayment();
    error VoucherAlreadyRedeemed();
    error InvalidSignature();
    error PaymentFailed();
    error VoucherExpired();

    event VoucherRedeemed(address indexed nft, uint256 indexed tokenId, address indexed artist, address collector, uint256 price);

    constructor() ERC721("Patronage Artwork", "PATRON") {
        // Prevent direct initialization of the base implementation contract
        initialized = true;
    }

    /// @notice Initializes a minimal-proxy clone exactly once.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        address creator_,
        address minter,
        address royaltyReceiver,
        uint96 royaltyBps
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (creator_ == address(0) || minter == address(0) || royaltyReceiver == address(0)) revert InvalidCreator();
        initialized = true; creator = creator_;
        nextTokenId = 1;
        _customName = name_; _customSymbol = symbol_;
        _grantRole(DEFAULT_ADMIN_ROLE, creator_); _grantRole(MINTER_ROLE, creator_); _grantRole(MINTER_ROLE, minter); _setDefaultRoyalty(royaltyReceiver, royaltyBps);
    }

    /// @notice Mints artwork token to the creator.
    function mint(string calldata metadataUri) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(creator, tokenId);
        _setTokenURI(tokenId, metadataUri);
    }

    /// @notice Dynamic EIP-712 domain separator supporting minimal proxy clones
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("PatronageArtwork")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    /// @notice Hashes an NFTVoucher according to EIP-712 specification
    function hashVoucher(NFTVoucher calldata voucher) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            VOUCHER_TYPEHASH,
            voucher.nft,
            voucher.tokenId,
            voucher.minPrice,
            keccak256(bytes(voucher.uri)),
            voucher.artist,
            voucher.nonce,
            voucher.deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Redeems an artist's signed voucher: collector pays price + gas, token is minted to collector
    function mintWithVoucher(NFTVoucher calldata voucher, bytes calldata signature) external payable returns (uint256 tokenId) {
        if (voucher.deadline == 0 || block.timestamp > voucher.deadline) revert VoucherExpired();
        if (voucher.nft != address(this)) revert InvalidVoucher();
        if (voucher.artist != creator) revert InvalidVoucher();
        if (msg.value < voucher.minPrice) revert InsufficientPayment();

        bytes32 digest = hashVoucher(voucher);
        if (redeemedVouchers[digest]) revert VoucherAlreadyRedeemed();

        address signer = ECDSA.recover(digest, signature);
        if (signer != voucher.artist) revert InvalidSignature();

        redeemedVouchers[digest] = true;

        tokenId = voucher.tokenId;
        if (tokenId == 0) {
            tokenId = nextTokenId++;
        } else {
            if (tokenId >= nextTokenId) {
                nextTokenId = tokenId + 1;
            }
        }

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, voucher.uri);

        if (msg.value > 0) {
            (bool ok,) = payable(voucher.artist).call{value: msg.value}("");
            if (!ok) revert PaymentFailed();
        }

        emit VoucherRedeemed(address(this), tokenId, voucher.artist, msg.sender, msg.value);
    }

    function name() public view override returns (string memory) {
        return bytes(_customName).length > 0 ? _customName : super.name();
    }

    function symbol() public view override returns (string memory) {
        return bytes(_customSymbol).length > 0 ? _customSymbol : super.symbol();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721URIStorage, ERC2981, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}

