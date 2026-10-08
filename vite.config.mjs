// The Claude Code preview panel picks a free port and hands it over as PORT. Vite ignores that unless
// told to use it, so the panel waited forever on a port nobody was listening on.
const port = Number(process.env.PORT);

export default {
  server: {
    port: port || 5173,
    strictPort: !!port
  }
};
