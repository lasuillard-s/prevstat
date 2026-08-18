import express from 'express';
import { router as authRouter } from './auth.js';

export const router = express.Router();

router.use('/auth', authRouter);
