# Hosted T3 Code

This Docker deployment is prepared for Railway. It runs the same verified T3 Code
0.0.45 and OpenCode 1.19.1 configuration as the Codespaces setup.

Deployment requirements:

- Connect the owner's Railway account before creating any hosted resources.
- Use the existing GitHub repository and the root `Dockerfile`.
- Attach a persistent volume at `/data` **before first startup**. Keep the tools
  in the image; the volume stores projects, history, authentication and caches.
- Create one public HTTPS service domain pointing at port 3773 (or `$PORT`).
- Stay on the account's Free/Trial plan. Do not add a paid plan or payment method.
- Verify outbound access to OpenCode; a Limited Trial can restrict networking.
- Check that T3 Code reports OpenCode as ready and exposes the free model.
- From an authenticated management shell, run `bash /app/server/pair.sh` and give
  only the HTTPS domain and the newly generated pairing code to the owner.
  Do not commit pairing codes or store them in public deployment logs.
- If shell access is unavailable, first confirm that deployment logs are private
  to the owner, set `T3_PRIVATE_ONBOARDING=1`, and read `PHONE_PAIRING_CODE` from
  those private logs. This standard phone grant works once and expires after
  one hour. The broad administrative startup grant stays in the private data
  directory. Clear the variable after the phone has paired. A redeployment can
  generate another phone grant.

The Docker image was tested with one CPU and 1 GiB RAM, including a completed
T3 -> OpenCode -> free DeepSeek conversation and preservation of that reply after
a container restart. The 512 MiB test ran out of memory during OpenCode discovery.
Use at least 1 GB for basic conversations; heavy projects and browser tasks can
need more.

Railway's trial currently permits 1 GB and includes a limited $5 credit. Its
ongoing Free plan permits only 512 MB and is not sufficient for the tested
configuration. Continuing after the trial can require a paid plan, which needs
the owner's explicit authorization before upgrading. This is not an unlimited
free server. A volume's data is also subject to Railway's retention policy after
credits expire.

The actual Railway deployment was verified through public HTTPS authentication,
public WSS, and a completed free DeepSeek conversation. Data was verified to
survive a container restart. The owner's Android pairing is the final client
step; do not put the phone's pairing code in this repository.
