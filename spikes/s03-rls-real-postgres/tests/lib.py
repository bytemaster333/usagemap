"""Shared helpers for the S-03 / S-05 harness (runs inside the runner container)."""
import json, os, sys, time
import psycopg

DIRECT = dict(host='pg', port=5432)
BOUNCER = dict(host='bouncer', port=6432)
PW = {'postgres': 'spike-super'}


def connect(user, db='scf', via='bouncer', autocommit=True, **kw):
    hp = BOUNCER if via == 'bouncer' else DIRECT
    return psycopg.connect(host=hp['host'], port=hp['port'], dbname=db, user=user,
                           password=PW.get(user, 'spike'), autocommit=autocommit, connect_timeout=10, **kw)


def err_text(e):
    d = getattr(e, 'diag', None)
    if d is not None and d.message_primary:
        return f'{d.sqlstate}: {d.message_primary}'
    return str(e).strip().splitlines()[0]


def try_sql(conn, sql, params=None, fetch=True):
    """Run one statement; return ('ok', rows) or ('error', 'SQLSTATE: message'). Leaves no open transaction on error."""
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall() if (fetch and cur.description) else None
        return 'ok', rows
    except psycopg.Error as e:
        if not conn.autocommit:
            conn.rollback()
        elif conn.info.transaction_status != psycopg.pq.TransactionStatus.IDLE:
            conn.execute('ROLLBACK')
        return 'error', err_text(e)


class Recorder:
    def __init__(self, path):
        self.path = path
        self.rows = []
        self.fail = 0

    def add(self, tid, what, expected, observed, ok, note=''):
        self.rows.append(dict(id=tid, what=what, expected=expected, observed=observed, ok=bool(ok), note=note))
        if not ok:
            self.fail += 1
        print(f"[{'PASS' if ok else 'FAIL'}] {tid}: {what}\n        expected: {expected}\n        observed: {observed}"
              + (f'\n        note: {note}' if note else ''), flush=True)

    def save(self):
        with open(self.path, 'w') as fh:
            json.dump(self.rows, fh, indent=1, default=str)
        print(f'== {len(self.rows) - self.fail}/{len(self.rows)} passed -> {self.path}', flush=True)
