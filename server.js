require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('qs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 10000;

/* -------------------------------
   1. MongoDB Connection
-------------------------------- */
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error("MongoDB Error:", err));

/* -------------------------------
   2. Transaction Schema (with retry fields)
-------------------------------- */
const transactionSchema = new mongoose.Schema({
    name: String,
    phone: String,
    amount: String,
    status: { type: String, default: "PENDING" },
    checkout_id: String,
    mpesa_receipt: String,
    retryCount: { type: Number, default: 0 },        // number of retries for this transaction
    lastRetryAt: { type: Date, default: null },      // timestamp of last retry attempt
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model("Transaction", transactionSchema);

/* -------------------------------
   3. Middleware
-------------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.static("docs"));

/* -------------------------------
   4. Root Route
-------------------------------- */
app.get("/", (req, res) => {
    res.send("sarahapay API Running");
});

/* -------------------------------
   5. OAuth Token (with timeout)
-------------------------------- */
async function getAccessToken() {
    try {
        const credentials = Buffer
            .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
            .toString("base64");

        const response = await axios.post(
            "https://api.kopokopo.com/oauth/token",
            qs.stringify({ grant_type: "client_credentials" }),
            {
                headers: {
                    Authorization: `Basic ${credentials}`,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                timeout: 10000
            }
        );

        return response.data.access_token;
    } catch (error) {
        console.error("OAuth Failure:", error.response?.data || error.message);
        throw new Error("Authentication failed");
    }
}

/* -------------------------------
   6. Helper: Initiate STK Push (reusable)
-------------------------------- */
async function initiateStkPush(name, phone, amount, retryCount = 0) {
    // Normalize phone number
    let formattedPhone = phone
        .replace(/\s+/g, '')
        .replace(/^\+/, '')
        .replace(/^0/, '254');

    // Split full name
    const names = name.trim().split(" ");
    const firstName = names[0];
    const lastName = names.slice(1).join(" ") || "Customer";

    const token = await getAccessToken();
    const formattedAmount = parseFloat(amount).toFixed(2);

    const payload = {
        payment_channel: "M-PESA STK Push",
        till_number: process.env.MERCHANT_NUMBER,
        subscriber: {
            first_name: firstName,
            last_name: lastName,
            phone_number: formattedPhone,
            email: "customer@example.com"
        },
        amount: {
            currency: "KES",
            value: formattedAmount
        },
        metadata: { notes: "Website Purchase" },
        _links: { callback_url: process.env.CALLBACK_URL }
    };

    console.log("STK Payload:", payload);

    const response = await axios.post(
        "https://api.kopokopo.com/api/v1/incoming_payments",
        payload,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            timeout: 10000
        }
    );

    const checkoutId = response.headers.location.split("/").pop();

    const tx = new Transaction({
        name,
        phone: formattedPhone,
        amount: formattedAmount,
        checkout_id: checkoutId,
        retryCount: retryCount,
        lastRetryAt: new Date()
    });

    await tx.save();
    return tx;
}

/* -------------------------------
   7. Initiate Payment (with retry logic)
-------------------------------- */
app.post("/api/pay", async (req, res) => {
    try {
        const { name, phone, amount } = req.body;
        if (!name || !phone || !amount) {
            return res.status(400).json({ error: "Name, phone and amount required" });
        }

        let formattedPhone = phone
            .replace(/\s+/g, '')
            .replace(/^\+/, '')
            .replace(/^0/, '254');

        // Find the most recent transaction for this phone
        const lastTx = await Transaction.findOne({ phone: formattedPhone })
            .sort({ createdAt: -1 });

        // If there is a pending transaction older than 3 minutes, mark it as FAILED (cleanup)
        if (lastTx && lastTx.status === "PENDING") {
            const minutesSince = (Date.now() - new Date(lastTx.createdAt).getTime()) / 60000;
            if (minutesSince > 3) {
                await Transaction.updateOne(
                    { _id: lastTx._id },
                    { status: "FAILED" }
                );
                console.log(`Auto-cleaned stale pending transaction ${lastTx._id}`);
            } else {
                // Still fresh pending – block new attempt
                return res.status(409).json({
                    error: "You already have a pending payment. Please wait or check your phone."
                });
            }
        }

        // Check retry limits for failed transactions
        if (lastTx && (lastTx.status === "FAILED" || lastTx.status === "CANCELLED")) {
            const minutesSinceLast = (Date.now() - new Date(lastTx.lastRetryAt || lastTx.createdAt).getTime()) / 60000;
            const retryCount = lastTx.retryCount || 0;

            if (retryCount >= 5) {
                // After 5 failures, enforce a 3-minute cooldown
                if (minutesSinceLast < 3) {
                    return res.status(429).json({
                        error: `Too many failed attempts. Please wait ${Math.ceil(3 - minutesSinceLast)} minute(s) before trying again.`
                    });
                } else {
                    // Cooldown passed – reset retry count for the next attempt
                    await Transaction.updateOne({ _id: lastTx._id }, { retryCount: 0 });
                }
            }
        }

        // Initiate a new STK push
        const tx = await initiateStkPush(name, formattedPhone, amount, lastTx?.retryCount || 0);
        res.status(201).json({
            message: "STK Push Sent",
            transactionId: tx._id
        });

    } catch (error) {
        console.error("STK Push Error:", error.response?.data || error.message);
        res.status(500).json({
            error: "Failed to initiate payment",
            details: error.response?.data || error.message
        });
    }
});

/* -------------------------------
   8. Retry Payment Endpoint
-------------------------------- */
app.post("/api/retry-payment", async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: "Phone number required" });
        }

        let formattedPhone = phone
            .replace(/\s+/g, '')
            .replace(/^\+/, '')
            .replace(/^0/, '254');

        // Find the most recent non-successful transaction for this phone
        const lastTx = await Transaction.findOne({
            phone: formattedPhone,
            status: { $in: ["PENDING", "FAILED", "CANCELLED"] }
        }).sort({ createdAt: -1 });

        if (!lastTx) {
            return res.status(404).json({ error: "No failed or pending transaction found to retry" });
        }

        const retryCount = lastTx.retryCount || 0;
        const minutesSinceLast = (Date.now() - new Date(lastTx.lastRetryAt || lastTx.createdAt).getTime()) / 60000;

        // Check retry limits
        if (retryCount >= 5) {
            if (minutesSinceLast < 3) {
                return res.status(429).json({
                    error: `Retry limit reached. Please wait ${Math.ceil(3 - minutesSinceLast)} minute(s) before trying again.`
                });
            } else {
                // Cooldown passed – reset retry count
                await Transaction.updateOne({ _id: lastTx._id }, { retryCount: 0 });
            }
        }

        // Mark the old transaction as FAILED (so it's no longer pending)
        await Transaction.updateOne(
            { _id: lastTx._id },
            { status: "FAILED", lastRetryAt: new Date() }
        );

        // Initiate a new STK push with increased retry count
        const newTx = await initiateStkPush(
            lastTx.name,
            formattedPhone,
            lastTx.amount,
            retryCount + 1
        );

        res.status(201).json({
            message: "Retry initiated. Check your phone for the M-PESA prompt.",
            transactionId: newTx._id,
            retryCount: retryCount + 1
        });

    } catch (error) {
        console.error("Retry payment error:", error);
        res.status(500).json({
            error: "Failed to retry payment",
            details: error.message
        });
    }
});

/* -------------------------------
   9. Fetch Transactions
-------------------------------- */
app.get("/api/transactions", async (req, res) => {
    try {
        const transactions = await Transaction.find().sort({ createdAt: -1 });
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch transactions" });
    }
});

/* -------------------------------
   10. Get Single Transaction by ID
-------------------------------- */
app.get("/api/transaction/:id", async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.id);
        if (!transaction) {
            return res.status(404).json({ error: "Transaction not found" });
        }
        res.json(transaction);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch transaction" });
    }
});

/* -------------------------------
   11. Payment Callback (CRASH‑PROOF)
-------------------------------- */
app.post("/callback", async (req, res) => {
    try {
        console.log("Callback received:", JSON.stringify(req.body, null, 2));

        if (!req.body || !req.body.data) {
            console.log("Empty callback payload – ignoring");
            return res.sendStatus(200);
        }

        const payload = req.body.data;
        const checkoutId = payload.id;
        const status = payload.attributes?.status;
        const receipt = payload.attributes?.event?.resource?.reference || "N/A";

        if (!checkoutId) {
            console.log("Callback missing checkoutId – ignoring");
            return res.sendStatus(200);
        }

        await Transaction.findOneAndUpdate(
            { checkout_id: checkoutId },
            { status: status, mpesa_receipt: receipt }
        );

        console.log(`Payment Update: ${status} | Receipt: ${receipt}`);
        res.sendStatus(200);
    } catch (error) {
        console.error("Callback Error:", error);
        res.sendStatus(200);
    }
});

/* -------------------------------
   12. Start Server
-------------------------------- */
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});