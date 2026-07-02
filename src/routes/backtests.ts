import fs from "fs";
import path from "path";
import { Router } from "express";

const engineDataPath = path.resolve(process.cwd(), "data/backtests/engines.json");

const router = Router();

// Public: the real ~20-year walk-forward backtest data (3 engines x 7 markets, net of fees).
router.get("/backtests/engines", (_req, res, next) => {
  try {
    const data = JSON.parse(fs.readFileSync(engineDataPath, "utf8"));
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export default router;
