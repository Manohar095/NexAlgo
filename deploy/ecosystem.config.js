// PM2 config — auto-restarts the platform if the process crashes for
// any reason, and starts it on boot if you set up PM2's startup hook.
//
// SETUP (one-time):
//   npm install -g pm2
//
// EDIT FIRST:
//   - `cwd`: absolute path to this project folder
//   - `interpreter`: path to your venv's python (recommended) or just
//     "python" / "python3" if you don't use a venv
//
// RUN:
//   pm2 start deploy/ecosystem.config.js
//   pm2 logs zenith-trading-terminal        # tail combined stdout/stderr
//   pm2 status                     # check it's alive
//   pm2 restart zenith-trading-terminal     # manual restart (e.g. after editing .env)
//   pm2 stop zenith-trading-terminal
//
// AUTO-START ON BOOT/LOGIN (optional):
//   pm2 startup        # follow the one-line command it prints
//   pm2 save           # persist the current process list

module.exports = {
  apps: [
    {
      name: "zenith-trading-terminal",
      script: "main.py",
      // Windows example (adjust drive/path):
      // interpreter: "F:/renko_platform/venv/Scripts/python.exe",
      // Mac/Linux example:
      // interpreter: "/path/to/renko_platform/venv/bin/python",
      interpreter: "python",
      cwd: __dirname + "/..",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,       // 5s between crash restarts
      min_uptime: "10s",         // must stay up 10s to count as a real start
      watch: false,              // don't restart on file changes (this isn't a dev reloader)
      out_file: "../logs/pm2_out.log",
      error_file: "../logs/pm2_error.log",
      merge_logs: true,
      env: {
        PYTHONUNBUFFERED: "1",
      },
    },
  ],
};
