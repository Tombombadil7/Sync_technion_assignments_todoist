// Loaded with node --import before sync_moodle.js. No real network requests are possible.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "axios") {
      return { url: new URL("./mock-axios-implementation.js", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
