// ---------------------------------------------------------------------
// CogniX Algo — login page
// ---------------------------------------------------------------------

const form       = document.getElementById("loginForm");
const totpField  = document.getElementById("totpField");
const errorBox   = document.getElementById("loginError");

(async function init() {
  try {
    const res = await fetch("/api/auth/status");
    const status = await res.json();
    if (status.totp_required) {
      totpField.classList.remove("hidden");
    }
    if (!status.auth_enabled) {
      // Shouldn't normally be reachable (middleware would let everything
      // through), but just in case someone lands here directly.
      window.location.href = "/";
    }
  } catch (e) {
    // If this fails, the form still works — totp field just stays hidden
    // until submit tells us otherwise via a 401.
  }
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.classList.add("hidden");

  const username  = document.getElementById("username").value;
  const password  = document.getElementById("password").value;
  const totp_code = document.getElementById("totp_code").value;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, totp_code }),
    });

    if (res.ok) {
      window.location.href = "/";
      return;
    }

    const data = await res.json().catch(() => ({}));
    errorBox.textContent = data.detail || "Login failed.";
    errorBox.classList.remove("hidden");

    // If the error is about a missing/invalid code, make sure the field is visible.
    if ((data.detail || "").toLowerCase().includes("authenticator")) {
      totpField.classList.remove("hidden");
    }
  } catch (err) {
    errorBox.textContent = "Could not reach the server. Try again.";
    errorBox.classList.remove("hidden");
  }
});
