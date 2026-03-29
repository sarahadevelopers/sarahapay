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
   2. Transaction Schema
-------------------------------- */

const transactionSchema = new mongoose.Schema({
    name: String,
    phone: String,
    amount: String,
    status: { type: String, default: "PENDING" },
    checkout_id: String,
    mpesa_receipt: String,
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

app.get("/", (req,res)=>{
    res.send("K2 Connect API Running");
});


/* -------------------------------
   5. OAuth Token (with timeout)
-------------------------------- */

async function getAccessToken(){
    try{
        const credentials = Buffer
        .from(`${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`)
        .toString("base64");

        const response = await axios.post(
            "https://api.kopokopo.com/oauth/token",
            qs.stringify({ grant_type:"client_credentials" }),
            {
                headers:{
                    Authorization:`Basic ${credentials}`,
                    "Content-Type":"application/x-www-form-urlencoded"
                },
                timeout: 10000 // 10 seconds timeout
            }
        );

        return response.data.access_token;

    }catch(error){
        console.error("OAuth Failure:", error.response?.data || error.message);
        throw new Error("Authentication failed");
    }
}


/* -------------------------------
   6. Initiate STK Push (with Fuliza fix)
-------------------------------- */

app.post("/api/pay", async (req,res)=>{
    try{
        const { name, phone, amount } = req.body;

        if(!name || !phone || !amount){
            return res.status(400).json({
                error:"Name, phone and amount required"
            });
        }

        /* Normalize phone number */
        let formattedPhone = phone
            .replace(/\s+/g,'')
            .replace(/^\+/,'')
            .replace(/^0/,'254');

        /* Prevent multiple pending STK pushes */
        const pending = await Transaction.findOne({
            phone: formattedPhone,
            status: "PENDING"
        });

        if(pending){
            return res.status(409).json({
                error:"Payment already pending for this phone"
            });
        }

        /* Split full name for KopoKopo */
        const names = name.trim().split(" ");
        const firstName = names[0];
        const lastName = names.slice(1).join(" ") || "Customer";

        const token = await getAccessToken();

        /* CRITICAL FIX: Format amount properly for Fuliza */
        const formattedAmount = parseFloat(amount).toFixed(2);

        const payload = {
            payment_channel:"M-PESA STK Push",
            till_number:process.env.MERCHANT_NUMBER,
            subscriber:{
                first_name:firstName,
                last_name:lastName,
                phone_number:formattedPhone,
                email:"customer@example.com"
            },
            amount:{
                currency:"KES",
                value:formattedAmount
            },
            metadata:{
                notes:"Website Purchase"
            },
            _links:{
                callback_url:process.env.CALLBACK_URL
            }
        };

        console.log("STK Payload:", payload);

        const response = await axios.post(
            "https://api.kopokopo.com/api/v1/incoming_payments",
            payload,
            {
                headers:{
                    Authorization:`Bearer ${token}`,
                    Accept:"application/json",
                    "Content-Type":"application/json"
                },
                timeout: 10000
            }
        );

        const checkoutId = response.headers.location.split("/").pop();

        const tx = new Transaction({
            name,
            phone: formattedPhone,
            amount: formattedAmount, // store the formatted amount
            checkout_id: checkoutId
        });

        await tx.save();

        res.status(201).json({
            message:"STK Push Sent",
            transactionId:tx._id
        });

    }catch(error){
        console.error("STK Push Error:", error.response?.data || error.message);
        res.status(500).json({
            error:"Failed to initiate payment",
            details:error.response?.data || error.message
        });
    }
});


/* -------------------------------
   7. Fetch Transactions
-------------------------------- */

app.get("/api/transactions", async (req,res)=>{
    try{
        const transactions = await Transaction
        .find()
        .sort({createdAt:-1});

        res.json(transactions);
    }catch(error){
        res.status(500).json({
            error:"Failed to fetch transactions"
        });
    }
});


/* -------------------------------
   8. Payment Callback (CRASH‑PROOF)
-------------------------------- */

app.post("/callback", async (req,res)=>{
    try{
        // Log the entire callback for debugging
        console.log("Callback received:", JSON.stringify(req.body, null, 2));

        // If there's no body or no data, just acknowledge (KopoKopo may send empty health checks)
        if(!req.body || !req.body.data){
            console.log("Empty callback payload – ignoring");
            return res.sendStatus(200);
        }

        const payload = req.body.data;
        const checkoutId = payload.id;
        const status = payload.attributes?.status;
        const receipt = payload.attributes?.event?.resource?.reference || "N/A";

        if(!checkoutId){
            console.log("Callback missing checkoutId – ignoring");
            return res.sendStatus(200);
        }

        await Transaction.findOneAndUpdate(
            { checkout_id: checkoutId },
            {
                status: status,
                mpesa_receipt: receipt
            }
        );

        console.log(`Payment Update: ${status} | Receipt: ${receipt}`);
        res.sendStatus(200);

    }catch(error){
        // Log the error but still return 200 so KopoKopo doesn't retry forever
        console.error("Callback Error:", error);
        res.sendStatus(200);
    }
});


/* -------------------------------
   9. Start Server
-------------------------------- */

app.listen(PORT,()=>{
    console.log(`Server running on port ${PORT}`);
});