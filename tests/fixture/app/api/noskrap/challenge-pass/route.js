import { createNoSkrapChallengePassHandler } from "noskrap/next";
import { config, verified } from "../../../../shared.js";
export const POST = createNoSkrapChallengePassHandler({ ...config, verifyChallenge: verified });
