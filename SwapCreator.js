const { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, Keypair, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createCloseAccountInstruction } = require("@solana/spl-token");
const { MongoClient, ObjectId } = require("mongodb");
const bs58 = require('bs58');
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
let db;

async function initMongo() {
    if (!db) {
        const mongoUri = process.env.MONGO_URI;
        const client = new MongoClient(mongoUri);
        await client.connect();
        db = client.db("bot");
        console.log("MongoDB initialized");
    }
}

async function fetchTokenDataFromMongo(tokenId) {
    await initMongo();
    const collection = db.collection("raydium_lp_transactionsV2");
    const document = await collection.findOne({ _id: new ObjectId(tokenId) });

    if (!document) {
        throw new Error(`Token data not found for ID: ${tokenId}`);
    }

    const requiredFields = [
        'ammId', 'ammAuthority', 'ammOpenOrders', 'tokenVault', 'solVault',
        'marketProgramId', 'marketId', 'marketBids', 'marketAsks', 'marketEventQueue',
        'marketBaseVault', 'marketQuoteVault', 'marketAuthority', 'programId'
    ];

    requiredFields.forEach(field => {
        if (!document[field]) {
            throw new Error(`Document missing required field: ${field}`);
        }
    });

    return document;
}

async function createSwapInstruction({
                                         tokenId,
                                         userOwnerPublicKey,
                                         userSource,
                                         userDestination,
                                         amountSpecified,
                                         swapBaseIn
                                     }) {
    const tokenData = await fetchTokenDataFromMongo(tokenId);

    const keys = [
        { pubkey: new PublicKey(tokenData.ammId), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.ammAuthority), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(tokenData.ammOpenOrders), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.tokenVault), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.solVault), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketProgramId), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(tokenData.marketId), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketBids), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketAsks), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketEventQueue), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketBaseVault), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketQuoteVault), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(tokenData.marketAuthority), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(userSource), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(userDestination), isSigner: false, isWritable: true },
        { pubkey: userOwnerPublicKey, isSigner: true, isWritable: false },
    ];

    const dataLayout = Buffer.alloc(9);
    dataLayout.writeUInt8(swapBaseIn ? 9 : 10, 0);
    dataLayout.writeBigUInt64LE(BigInt(amountSpecified), 1);

    return new TransactionInstruction({
        keys,
        programId: new PublicKey(tokenData.programId),
        data: dataLayout
    });
}

async function swapTokens({
                              tokenId,
                              userSource,
                              userDestination,
                              amountSpecified,
                              swapBaseIn
                          }) {
    try {
        console.log(`Starting swap with MongoDB ID: ${tokenId}`);
        const userOwner = Keypair.fromSecretKey(
            bs58.default.decode(process.env.WALLET_PRIVATE_KEY)
        );
        const userOwnerPublicKey = userOwner.publicKey;

        const tokenData = await fetchTokenDataFromMongo(tokenId);
        const isWSOL = tokenData.tokenAddress === WSOL_MINT.toString();

        let tempWSOLAccount = null;
        if (isWSOL) {
            tempWSOLAccount = getAssociatedTokenAddressSync(
                WSOL_MINT,
                userOwnerPublicKey,
                true
            );

            const wrapIx = SystemProgram.transfer({
                fromPubkey: userOwnerPublicKey,
                toPubkey: tempWSOLAccount,
                lamports: amountSpecified
            });

            const createATAIx = createAssociatedTokenAccountInstruction(
                userOwnerPublicKey,
                tempWSOLAccount,
                userOwnerPublicKey,
                WSOL_MINT
            );

            userSource = tempWSOLAccount.toString();
        }

        if (!tokenData?.tokenAddress) {
            throw new Error("Invalid token data - missing token address");
        }

        const decimals = tokenData.decimals || 9;
        const rawAmount = Math.floor(amountSpecified * 10 ** decimals);

        const walletBalance = await connection.getBalance(userOwnerPublicKey);
        const requiredBalance = 0.05 * 1e9;

        if (walletBalance < requiredBalance) {
            throw new Error(`Insufficient SOL balance. Required: ${requiredBalance / 1e9} SOL, Current: ${walletBalance / 1e9} SOL`);
        }

        console.log('Starting swap with parameters:', {
            amount: amountSpecified,
            rawAmount,
            decimals,
            swapBaseIn,
            source: userSource,
            destination: userDestination
        });

        const swapIx = await createSwapInstruction({
            tokenId,
            userOwnerPublicKey,
            userSource,
            userDestination,
            amountSpecified: rawAmount,
            swapBaseIn
        });

        const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 });
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 });

        const transaction = new Transaction()
            .add(computeLimitIx)
            .add(priorityFeeIx)
            .add(swapIx);

        if (isWSOL && tempWSOLAccount) {
            const closeAccountIx = createCloseAccountInstruction(
                tempWSOLAccount,
                userOwnerPublicKey,
                userOwnerPublicKey
            );
            transaction.add(closeAccountIx);
        }

        transaction.feePayer = userOwnerPublicKey;
        transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const signature = await connection.sendTransaction(transaction, [userOwner]);
        await connection.confirmTransaction(signature);

        console.log('Swap successful:', signature);
        return signature;

    } catch (error) {
        console.error('Swap failed:', {
            _id: tokenId,
            error: error.message,
            amount: amountSpecified
        });
        throw error;
    }
}

module.exports = {
    swapTokens,
    fetchTokenDataFromMongo
};