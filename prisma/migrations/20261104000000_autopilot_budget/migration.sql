-- Autopilot runs reserve a larger, explicitly bounded model-request budget.
ALTER TABLE "Run" ADD COLUMN "modelCallLimit" INTEGER NOT NULL DEFAULT 6;
