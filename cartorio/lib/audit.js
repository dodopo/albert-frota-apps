export const AUDIT_STATUSES = {
  RECEIPT_VALID: 'receipt-valid',
  BREAK_GLASS_VALID: 'break-glass-valid',
  FAIL: 'fail'
};

export async function auditLocalRepository() {
  return {
    status: AUDIT_STATUSES.FAIL,
    reason: 'audit real nao implementado no passo 2'
  };
}

export async function reconcileBreakGlass() {
  throw new Error('audit.reconcileBreakGlass not_implemented');
}
