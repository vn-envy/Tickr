CREATE TABLE "Business" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "website" TEXT,
  "locality" TEXT NOT NULL,
  "vertical" TEXT NOT NULL,
  "goal" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "Run" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "businessId" TEXT NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'created',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Run_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Run_businessId_idx" ON "Run"("businessId");
CREATE TABLE "Evidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "claim" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "support" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Evidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Evidence_runId_idx" ON "Evidence"("runId");
CREATE TABLE "StageArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StageArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StageArtifact_runId_stage_version_key" ON "StageArtifact"("runId", "stage", "version");

-- FTS indexes only stored evidence. It performs no network or model calls.
CREATE VIRTUAL TABLE "EvidenceSearch" USING fts5("id" UNINDEXED, "claim", "excerpt");
CREATE TRIGGER "Evidence_search_insert" AFTER INSERT ON "Evidence" BEGIN
  INSERT INTO "EvidenceSearch"("id", "claim", "excerpt") VALUES (new."id", new."claim", new."excerpt");
END;
CREATE TRIGGER "Evidence_search_update" AFTER UPDATE ON "Evidence" BEGIN
  DELETE FROM "EvidenceSearch" WHERE "id" = old."id";
  INSERT INTO "EvidenceSearch"("id", "claim", "excerpt") VALUES (new."id", new."claim", new."excerpt");
END;
CREATE TRIGGER "Evidence_search_delete" AFTER DELETE ON "Evidence" BEGIN
  DELETE FROM "EvidenceSearch" WHERE "id" = old."id";
END;
