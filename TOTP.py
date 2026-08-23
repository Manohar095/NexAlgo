import pyotp

# Replace with your actual secret (base32 encoded)
secret = "LU5ZQ52LHOJT2LTLFUDC3HNQZKE3KFWX"  # example from the TOTP spec

# Create a TOTP object
totp = pyotp.TOTP(secret)

# Get the current 6‑digit code
current_code = totp.now()
print(f"Your TOTP code is: {current_code}")

# If you need a specific time (e.g. for testing), use:
# code_at_time = totp.at(1609459200)  # Unix timestamp