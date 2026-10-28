import * as core from "@actions/core";

import { failure, run } from "./main.js";

run().catch((error: unknown) => core.setFailed(failure(error)));
