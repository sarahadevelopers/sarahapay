async function handlePayment() {
    const btn = document.getElementById("payBtn");
    const status = document.getElementById("status");

    const name = document.getElementById("name").value;
    const phone = document.getElementById("phone").value;
    const amount = document.getElementById("amount").value;

    if (!name || !phone || !amount) {
        alert("Please fill in name, phone and amount");
        return;
    }

    // UI feedback
    btn.disabled = true;
    btn.innerText = "Processing...";

    status.style.color = "blue";
    status.innerText = "Requesting M-Pesa prompt...";

    try {
        // Use the full backend URL
        const API_URL = "https://sarahapay.onrender.com/api/pay";
        
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                name: name,
                phone: phone,
                amount: amount
            })
        });

        const data = await response.json();

        if (response.ok) {
            status.style.color = "green";
            status.innerText = "STK Push sent. Check your phone.";
            // Optional: clear form
            // document.getElementById("name").value = "";
            // document.getElementById("phone").value = "";
            // document.getElementById("amount").value = "";
        } else {
            status.style.color = "red";
            status.innerText = data.error || data.details || "Payment failed";
        }
    } catch (err) {
        console.error("Payment error:", err);
        status.style.color = "red";
        status.innerText = "Server error. Please try again.";
    }

    btn.disabled = false;
    btn.innerText = "Pay Now";
}