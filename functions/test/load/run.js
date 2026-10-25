// Runs both load tests one after the other against the Firestore emulator.
//   cd functions && npm run load
const backend = require("./backend.load");
const fanout = require("./fanout.load");

(async () => {
  const failures = (await backend.run()) + (await fanout.run());
  console.log(failures ? "\n" + failures + " FAILED" : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
