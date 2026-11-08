# Manager handover migration

Apply `20261105_manager_handover.sql` before starting a backend with the new
manager handover service. The migration is idempotent.

The one-time correction requested for this database is available separately:

```powershell
node scripts/normalize_admin_managers.js
node scripts/normalize_admin_managers.js --apply
```

The first command previews the exact accounts affected. The second retains
Quách Tô Phong, removes only the explicitly identified other ADMIN, clears the
pending-password flag on managers without changing their passwords, installs the
handover table, and enforces at most one ADMIN with a filtered unique index.
It saves the previous rows in `.local-backups/`, which is excluded from Git.
Backups contain private account data and password hashes; keep them local.

Handover passwords are encrypted with AES-256-GCM using a key derived from
`ADMIN_SESSION_SECRET`. They can be resent for seven days while the manager has
not changed their temporary password. Keep the session secret stable across
backend instances. No plaintext handover password is returned to the frontend.
SMTP acceptance means the sending server accepted the email, not proof that it
arrived in the recipient's inbox.

Run the integration checks against a configured SQL Server:

```powershell
$env:RUN_DB_HANDOVER_TESTS = '1'
node --test test/manager_handover.test.js
```

These tests execute the real SQL under outer transactions and roll back every
test. Emails are stubbed. They require an active ADMIN, an assigned manager,
an unassigned active manager, and an unassigned accommodation. Running
`npm run test:handover` without that environment flag runs encryption checks
and skips database tests.
