const router = require('express').Router();
const service = require('../../services/pricing_service');
const permission = require('../../middlewares/requirePermission');
const {
  ok,
  fail
} = require('../../utils/response');
const handle = fn => async (req, res) => {
  try {
    return ok(res, await fn(req));
  } catch (e) {
    if (!e.statusCode) console.error('[pricing]', e.code || e.message);
    return fail(res, e.statusCode || 500, e.errorCode || 'PRICING_ERROR', e.statusCode ? e.message : 'Không thể xử lý dữ liệu giá. Vui lòng thử lại.');
  }
};
router.get('/bootstrap', permission('pricing.read'), handle(r => service.bootstrap(r.currentAdmin)));
router.get('/calendar', permission('pricing.read'), handle(r => service.calendar(r.query, r.currentAdmin)));
router.get('/history', permission('pricing.read'), handle(r => service.history(r.query, r.currentAdmin)));
router.get('/proposals', permission('pricing.read'), handle(r => service.proposals(r.query, r.currentAdmin)));
router.post('/proposals/:id/preview', permission('pricing.write'), handle(r => service.reviewProposal(r.params.id,r.body,r.currentAdmin,'preview')));
router.post('/proposals/:id/approve', permission('pricing.write'), handle(r => service.reviewProposal(r.params.id,r.body,r.currentAdmin,'approve')));
router.post('/proposals/:id/reject', permission('pricing.write'), handle(r => service.reviewProposal(r.params.id,r.body,r.currentAdmin,'reject')));
router.post('/preview', permission('pricing.write'), handle(r => service.change(r.body, r.currentAdmin, false)));
router.post('/apply', permission('pricing.write'), handle(r => service.change(r.body, r.currentAdmin, true)));
router.post('/periods', permission('pricing.write'), handle(r => service.savePeriod(r.body, r.currentAdmin)));
router.put('/periods/:id', permission('pricing.write'), handle(r => service.savePeriod(r.body, r.currentAdmin, r.params.id)));
router.delete('/periods/:id', permission('pricing.write'), handle(r => service.savePeriod(r.body, r.currentAdmin, r.params.id, true)));
module.exports = router;
