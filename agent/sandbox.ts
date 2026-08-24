import { defineSandbox, defaultBackend } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

export default defineSandbox({
  backend:
    process.env.APP_BUILDER_TEST_MODEL === "1" ? justbash() : defaultBackend(),
});
