/**
 * Prefix: /api/admin/financial-reports/*
 */

const express = require("express");
const router = express.Router();

const financialReportAdminController = require("../../controllers/admin/financialReportAdminController");
const requireAdminLogin = require("../../middlewares/requireAdminLogin");
const requirePermission = require("../../middlewares/requirePermission");
const requireRole = require("../../middlewares/requireRole");

router.get(
  "/overview",
  requireAdminLogin,
  requirePermission("reports.view"),
  financialReportAdminController.getOverview,
);

router.get(
  "/accommodations/:id",
  requireAdminLogin,
  requirePermission("reports.view"),
  financialReportAdminController.getAccommodationDetail,
);

router.put(
  "/accommodations/:id/ledger",
  requireAdminLogin,
  requireRole("ADMIN"),
  financialReportAdminController.upsertLedger,
);

router.put(
  "/accommodations/:id/profile",
  requireAdminLogin,
  requireRole("ADMIN"),
  financialReportAdminController.updateProfile,
);

router.get(
  "/bonus-preview",
  requireAdminLogin,
  requirePermission("reports.view"),
  financialReportAdminController.getBonusPreview,
);

router.post(
  "/bonus-approve",
  requireAdminLogin,
  requireRole("ADMIN"),
  financialReportAdminController.approveBonuses,
);

router.post(
  "/accommodations/:id/send-warning-email",
  requireAdminLogin,
  requireRole("ADMIN"),
  financialReportAdminController.sendWarningEmail,
);

router.get(
  "/payments-ledger",
  requireAdminLogin,
  requirePermission("reports.view"),
  financialReportAdminController.getPaymentsLedger,
);

module.exports = router;
