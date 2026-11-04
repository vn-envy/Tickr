// Keeps the test suite hermetic: secrets and deployment flags from the machine running the tests
// (for example a cloud session with TICKR_ACCESS_CODE or META_API_KEY set) must never switch on the
// access gate, live Meta clients or proxy modes. Tests that need one of these set it themselves.
const AMBIENT_KEYS = [
  "TICKR_ACCESS_CODE",
  "TICKR_DEPLOYMENT",
  "TICKR_SECRET_KEY",
  "TICKR_ALLOWED_HOSTS",
  "TICKR_PROXY_CONNECT_BY_HOSTNAME",
  "META_API_KEY",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_OAUTH_REDIRECT_URI",
  "META_LOGIN_CONFIG_ID",
  "META_CRITIC_MODEL",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
];

for (const key of AMBIENT_KEYS) delete process.env[key];
