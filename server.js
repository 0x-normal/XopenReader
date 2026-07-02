/** Local / VPS entry point. For Vercel, see api/index.js */
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X Open Reader on :${PORT} (${app.AUTHED ? 'authenticated' : 'guest mode'})`);
});
