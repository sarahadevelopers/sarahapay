async function handlePayment(){

const btn = document.getElementById("payBtn");
const status = document.getElementById("status");

const name = document.getElementById("name").value;
const phone = document.getElementById("phone").value;
const amount = document.getElementById("amount").value;

if(!name || !phone || !amount){
    alert("Please fill in name, phone and amount");
    return;
}

/* UI feedback */
btn.disabled = true;
btn.innerText = "Processing...";

status.style.color = "blue";
status.innerText = "Requesting M-Pesa prompt...";

try{

const response = await fetch("/api/pay",{
    method:"POST",
    headers:{
        "Content-Type":"application/json"
    },
    body:JSON.stringify({
        name,
        phone,
        amount
    })
});

const data = await response.json();

if(response.ok){

    status.style.color = "green";
    status.innerText = "STK Push sent. Check your phone.";

}else{

    status.style.color = "red";
    status.innerText = data.error || "Payment failed";

}

}catch(err){

status.style.color = "red";
status.innerText = "Server error";

}

btn.disabled = false;
btn.innerText = "Pay Now";

}