// Helper: display status message
function showStatus(message, type) {
    const status = document.getElementById("status");
    if (!status) return;
    status.style.color = type === "success" ? "green" : type === "error" ? "red" : "blue";
    status.innerText = message;
}

// Helper: enable/disable pay button
function setPayButton(disabled, text = null) {
    const btn = document.getElementById("payBtn");
    if (!btn) return;
    btn.disabled = disabled;
    if (text !== null) btn.innerText = text;
}

// Retry payment using /api/retry-payment endpoint
async function retryPayment(phone) {
    const retryBtn = document.getElementById("retryBtn");
    if (retryBtn) {
        retryBtn.disabled = true;
        retryBtn.innerText = "Retrying...";
    }
    showStatus("Retrying payment...", "blue");

    try {
        const API_RETRY_URL = "https://sarahapay.onrender.com/api/retry-payment";
        const response = await fetch(API_RETRY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: phone })
        });
        const data = await response.json();

        if (response.ok) {
            showStatus(data.message || "Retry initiated. Check your phone for M-PESA prompt.", "success");
            // Remove retry button if present
            const rb = document.getElementById("retryBtn");
            if (rb) rb.remove();
            // Re-enable pay button? User may want to pay again, but we keep it enabled.
            setPayButton(false, "Pay Now");
        } else if (response.status === 429) {
            // Cooldown period – show wait time
            const errorMsg = data.error || "Too many failed attempts. Please wait.";
            showStatus(errorMsg, "error");
            // Extract minutes from error message (e.g., "wait 3 minute(s)")
            const match = errorMsg.match(/(\d+)\s*minute/);
            if (match && match[1]) {
                const waitMinutes = parseInt(match[1]);
                startCooldownTimer(waitMinutes * 60, phone);
            } else {
                // Fallback: try again after 3 minutes
                startCooldownTimer(180, phone);
            }
        } else {
            showStatus(data.error || "Retry failed. Try again later.", "error");
            if (retryBtn) {
                retryBtn.disabled = false;
                retryBtn.innerText = "Retry Payment";
            }
        }
    } catch (err) {
        console.error("Retry error:", err);
        showStatus("Network error. Please refresh and try again.", "error");
        if (retryBtn) {
            retryBtn.disabled = false;
            retryBtn.innerText = "Retry Payment";
        }
    }
}

// Countdown timer for cooldown period
function startCooldownTimer(seconds, phone) {
    let remaining = seconds;
    const timerInterval = setInterval(() => {
        if (remaining <= 0) {
            clearInterval(timerInterval);
            showStatus("You can now retry again.", "blue");
            const retryBtn = document.getElementById("retryBtn");
            if (retryBtn) {
                retryBtn.disabled = false;
                retryBtn.innerText = "Retry Payment";
                // Re-attach event listener (in case it was removed)
                retryBtn.onclick = () => retryPayment(phone);
            } else {
                // Re-create retry button if missing
                offerRetryButton(phone);
            }
        } else {
            const minutes = Math.floor(remaining / 60);
            const secs = remaining % 60;
            showStatus(`Too many failed attempts. Please wait ${minutes}:${secs < 10 ? '0'+secs : secs} before retrying.`, "error");
            remaining--;
        }
    }, 1000);
}

// Create or show retry button
function offerRetryButton(phone) {
    let retryBtn = document.getElementById("retryBtn");
    if (!retryBtn) {
        retryBtn = document.createElement("button");
        retryBtn.id = "retryBtn";
        retryBtn.innerText = "Retry Payment";
        retryBtn.style.marginTop = "10px";
        retryBtn.style.padding = "10px 20px";
        retryBtn.style.backgroundColor = "#ff9800";
        retryBtn.style.border = "none";
        retryBtn.style.borderRadius = "5px";
        retryBtn.style.cursor = "pointer";
        retryBtn.onclick = () => retryPayment(phone);
        // Insert after pay button
        const payBtn = document.getElementById("payBtn");
        if (payBtn && payBtn.parentNode) {
            payBtn.parentNode.insertBefore(retryBtn, payBtn.nextSibling);
        } else {
            document.getElementById("paymentForm").appendChild(retryBtn);
        }
    } else {
        retryBtn.style.display = "block";
        retryBtn.disabled = false;
        retryBtn.innerText = "Retry Payment";
        retryBtn.onclick = () => retryPayment(phone);
    }
}

// Main payment function (unchanged except integration with retry)
async function handlePayment() {
    const btn = document.getElementById("payBtn");
    const name = document.getElementById("name").value;
    const phone = document.getElementById("phone").value;
    const amount = document.getElementById("amount").value;

    if (!name || !phone || !amount) {
        alert("Please fill in name, phone and amount");
        return;
    }

    setPayButton(true, "Processing...");
    showStatus("Requesting M-Pesa prompt...", "blue");

    try {
        const API_URL = "https://sarahapay.onrender.com/api/pay";
        const response = await fetch(API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, phone, amount })
        });
        const data = await response.json();

        if (response.ok) {
            showStatus("STK Push sent. Check your phone.", "success");
            // Remove any existing retry button
            const rb = document.getElementById("retryBtn");
            if (rb) rb.remove();
        } else {
            // Payment failed – show error and offer retry
            const errorMsg = data.error || data.details || "Payment failed";
            showStatus(errorMsg, "error");
            // Offer retry button for failures (except if it's a pending conflict? we still offer)
            if (response.status === 409) {
                showStatus("You already have a pending payment. Check your phone or wait a few minutes.", "error");
            } else if (response.status === 429) {
                // Cooldown – start timer and show retry button after cooldown
                const waitMatch = errorMsg.match(/(\d+)\s*minute/);
                if (waitMatch && waitMatch[1]) {
                    startCooldownTimer(parseInt(waitMatch[1]) * 60, phone);
                } else {
                    startCooldownTimer(180, phone); // default 3 min
                }
            } else {
                // Generic failure – offer retry immediately
                offerRetryButton(phone);
            }
        }
    } catch (err) {
        console.error("Payment error:", err);
        showStatus("Server error. Please try again.", "error");
        offerRetryButton(phone);
    } finally {
        setPayButton(false, "Pay Now");
    }
}

// Ensure retry button is removed when a new payment is attempted (optional)
// Also ensure that when user clicks pay again, any ongoing timer is reset? Not needed.