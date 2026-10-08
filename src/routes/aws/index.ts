import express from "express";
import { router as sqsRouter } from "./sqs.js";

export const router = express.Router();

router.use("/sqs", sqsRouter);
