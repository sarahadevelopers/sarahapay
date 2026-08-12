require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

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
    retryCount: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
});

const Transaction = mongoose.model("Transaction", transactionSchema);

/* -------------------------------
   3. Middleware (CORS, JSON, Static) – with allowed origins
-------------------------------- */
const allowedOrigins = [
    'https://bingwasoko.co.ke',
    'https://www.bingwasoko.co.ke',
    'https://datasokoni.com',
    'https://www.datasokoni.com',
    'https://fineescorts.co.ke',
    'https://www.fineescorts.co.ke',
    'https://sarahadevelopers.github.io',
    'http://localhost:3000',
    'https://fine-2zxp.onrender.com'  // ✅ ADD THIS
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static("docs"));

// ---------- SHARED SECRET CHECK (for both payment endpoints) ----------
const checkSecret = (req, res, next) => {
    const secret = req.headers['x-api-secret'];
    if (secret !== process.env.API_SECRET) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
};

// ---------- reCAPTCHA VERIFICATION (for payment endpoints) ----------
// Sarahapay server.js – UPDATE verifyRecaptcha
const verifyRecaptcha = async (req, res, next) => {
    // ✅ Check BOTH headers and body
    const token = req.headers['x-recaptcha-token'] || req.body.recaptchaToken;
    
    if (!token) {
        return res.status(400).json({ error: "Missing reCAPTCHA token" });
    }

    try {
        const verification = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: {
                    secret: process.env.RECAPTCHA_SECRET,
                    response: token
                },
                timeout: 5000
            }
        );

        const { success, score } = verification.data;
        if (!success || score < 0.5) {
            console.log(`reCAPTCHA failed: success=${success}, score=${score}`);
            return res.status(403).json({ error: "Bot detected. Please try again." });
        }

        next();
    } catch (error) {
        console.error("reCAPTCHA verification error:", error);
        return res.status(500).json({ error: "CAPTCHA verification failed" });
    }
};

// ---------- GLOBAL RATE LIMIT (all IPs combined) ----------
let globalRequestCount = 0;
let globalWindowStart = Date.now();
const GLOBAL_MAX = 50;
const GLOBAL_WINDOW = 60 * 1000;

const globalRateLimit = (req, res, next) => {
    const now = Date.now();
    if (now - globalWindowStart > GLOBAL_WINDOW) {
        globalRequestCount = 0;
        globalWindowStart = now;
    }
    globalRequestCount++;
    if (globalRequestCount > GLOBAL_MAX) {
        return res.status(429).json({ error: "Global request limit reached. Please try again later." });
    }
    next();
};

// ---------- Apply middleware to payment endpoints ----------
app.use('/api/pay', checkSecret);
app.use('/api/retry-payment', checkSecret);
app.use('/api/pay', verifyRecaptcha);
app.use('/api/retry-payment', verifyRecaptcha);
app.use('/api/pay', globalRateLimit);
app.use('/api/retry-payment', globalRateLimit);

// ---------- RATE LIMITING & IP BLOCKING (per‑IP) ----------
const violationStore = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of violationStore.entries()) {
        if (data.blockUntil && data.blockUntil < now) {
            violationStore.delete(ip);
        } else if (!data.blockUntil && (now - data.firstViolationTime) > 3600000) {
            violationStore.delete(ip);
        }
    }
}, 60000);

const checkBlocked = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const data = violationStore.get(ip);
    if (data && data.blockUntil && data.blockUntil > now) {
        return res.status(403).json({
            error: `Your IP is temporarily blocked due to excessive failed attempts. Try again after ${Math.ceil((data.blockUntil - now) / 60000)} minutes.`
        });
    }
    next();
};

const paymentLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 3,
    message: { error: "Too many payment requests from this IP. Please wait 5 minutes." },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        const ip = req.ip || req.connection.remoteAddress;
        const now = Date.now();
        const data = violationStore.get(ip) || { count: 0, firstViolationTime: now, blockUntil: null };
        data.count += 1;
        if (data.count >= 3) {
            data.blockUntil = now + 3600000;
            violationStore.set(ip, data);
            res.status(429).json({
                error: "Too many failed payment attempts. Your IP has been blocked for 1 hour."
            });
        } else {
            violationStore.set(ip, data);
            res.status(429).json({
                error: "Too many payment requests from this IP. Please wait 5 minutes."
            });
        }
    }
});

app.use('/api/pay', checkBlocked, paymentLimiter);
app.use('/api/retry-payment', checkBlocked, paymentLimiter);

/* -------------------------------
   4. Root Route
-------------------------------- */
app.get("/", (req, res) => {
    res.send("sarahapay API Running – Paywave Express");
});

/* -------------------------------
   5. Helper: Initiate STK Push (Paywave Express)
-------------------------------- */
async function initiateStkPush(name, phone, amount, retryCount = 0) {
    // Normalize phone number
    let formattedPhone = phone
        .replace(/\s+/g, '')
        .replace(/^\+/, '')
        .replace(/^0/, '254');

    // Paywave accepts phone in 254XXXXXXXXX format
    if (!formattedPhone.startsWith('254')) {
        formattedPhone = '254' + formattedPhone;
    }

    const payload = {
        api_key: process.env.PAYWAVE_API_KEY,
        email: process.env.PAYWAVE_EMAIL || 'codewithkaranja@gmail.com',
        amount: parseFloat(amount).toFixed(2),
        msisdn: formattedPhone,
        reference: name || 'Payment via Sarahapay'
    };

    console.log("Paywave STK Payload:", payload);

    const response = await axios.post(
        'https://paywavexpress.co.ke/v1/stkpush',
        payload,
        {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        }
    );

    console.log("Paywave Response:", response.data);

    const data = response.data;

    // Check success – Paywave returns ResponseCode: '0' for success
    if (data.ResponseCode === '0' || data.success === '200') {
        const checkoutId = data.transactionId || data.TransactionID || 'paywave_' + Date.now();
        const tx = new Transaction({
            name: name || 'Paywave Payment',
            phone: formattedPhone,
            amount: parseFloat(amount).toFixed(2),
            checkout_id: checkoutId,
            retryCount: retryCount,
            lastRetryAt: new Date()
        });
        await tx.save();
        return tx;
    } else {
        const errorMsg = data.errorMessage || data.message || data.ResponseDescription || 'Paywave payment failed';
        throw new Error(errorMsg);
    }
}

/* -------------------------------
   6. Initiate Payment (with 30‑second timeout & retry logic)
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

        // ---------- 30‑second timeout for pending transactions ----------
        if (lastTx && lastTx.status === "PENDING") {
            const secondsSince = (Date.now() - new Date(lastTx.createdAt).getTime()) / 1000;
            if (secondsSince > 30) {
                await Transaction.updateOne(
                    { _id: lastTx._id },
                    { status: "FAILED" }
                );
                console.log(`Auto‑cleaned stale pending transaction ${lastTx._id} after 30s`);
            } else {
                return res.status(409).json({
                    error: "You already have a pending payment. Please wait or check your phone."
                });
            }
        }

        // ---------- Retry limit handling (max 5 attempts) ----------
        if (lastTx && (lastTx.status === "FAILED" || lastTx.status === "CANCELLED")) {
            const retryCount = lastTx.retryCount || 0;
            const secondsSinceLast = (Date.now() - new Date(lastTx.lastRetryAt || lastTx.createdAt).getTime()) / 1000;

            if (retryCount >= 5) {
                if (secondsSinceLast < 30) {
                    return res.status(429).json({
                        error: `Too many failed attempts (${retryCount}). Please wait ${Math.ceil(30 - secondsSinceLast)} seconds before trying again.`
                    });
                } else {
                    await Transaction.updateOne({ _id: lastTx._id }, { retryCount: 0 });
                }
            }
        }

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
   7. Retry Payment Endpoint
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

        const lastTx = await Transaction.findOne({
            phone: formattedPhone,
            status: { $in: ["PENDING", "FAILED", "CANCELLED"] }
        }).sort({ createdAt: -1 });

        if (!lastTx) {
            return res.status(404).json({ error: "No failed or pending transaction found to retry" });
        }

        const retryCount = lastTx.retryCount || 0;
        const secondsSinceLast = (Date.now() - new Date(lastTx.lastRetryAt || lastTx.createdAt).getTime()) / 1000;

        if (retryCount >= 5) {
            if (secondsSinceLast < 30) {
                return res.status(429).json({
                    error: `Retry limit reached (${retryCount}). Please wait ${Math.ceil(30 - secondsSinceLast)} seconds before trying again.`
                });
            } else {
                await Transaction.updateOne({ _id: lastTx._id }, { retryCount: 0 });
            }
        }

        await Transaction.updateOne(
            { _id: lastTx._id },
            { status: "FAILED", lastRetryAt: new Date() }
        );

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
   8. Fetch Transactions
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
   9. Get Single Transaction by ID
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
   10. Payment Callback (Webhook) – Paywave Express
-------------------------------- */
app.post("/callback", async (req, res) => {
    try {
        console.log("Callback received:", JSON.stringify(req.body, null, 2));

        // Paywave may send different payload structures; we'll try to extract common fields.
        const payload = req.body;

        // Try to find a transaction ID and status
        let checkoutId = payload.transactionId || payload.TransactionID || payload.transaction_id || payload.checkoutRequestID;
        let status = payload.status || payload.Status || payload.ResponseDescription;
        let receipt = payload.receipt || payload.MpesaReceiptNumber || payload.transactionId;

        // If no ID found, check if it's nested
        if (!checkoutId && payload.data) {
            const data = payload.data;
            checkoutId = data.transactionId || data.TransactionID || data.transaction_id || data.checkoutRequestID;
            status = data.status || data.Status;
            receipt = data.receipt || data.MpesaReceiptNumber;
        }

        if (!checkoutId) {
            console.log("Callback missing transaction ID – ignoring");
            return res.sendStatus(200);
        }

        // Normalize status to match our schema (uppercase)
        if (status) {
            status = status.toUpperCase();
            // Map common statuses
            if (status.includes('SUCCESS') || status.includes('COMPLETED')) {
                status = 'SUCCESS';
            } else if (status.includes('FAILED') || status.includes('CANCELLED') || status.includes('REVERSED') || status.includes('TIMEOUT')) {
                status = 'FAILED';
            } else {
                status = status; // keep as is
            }
        } else {
            status = 'PENDING';
        }

        // Update transaction
        const updateResult = await Transaction.findOneAndUpdate(
            { checkout_id: checkoutId },
            {
                status: status,
                mpesa_receipt: receipt || 'N/A'
            },
            { new: true }
        );

        if (updateResult) {
            console.log(`Payment Update: ${status} | Receipt: ${receipt}`);
        } else {
            console.log(`Transaction not found for checkout_id: ${checkoutId}`);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error("Callback Error:", error);
        res.sendStatus(200); // Always 200 to prevent retries
    }
});

/* -------------------------------
   11. Start Server
-------------------------------- */
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});