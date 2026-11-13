"""Tiny Azure Blob helper for S-08 (runs against Azurite over TLS).

Usage: az.py <A|B> <command> [args]
  mk <container>                       create container (idempotent)
  sas <container> <perms> [hours]      print a container SAS token (service SAS) with the given perms
  ls <container> [prefix]              list blobs (name, size)
  count <container> [prefix]           count blobs
  rm <container> <prefix>              delete every blob under prefix (simulates a lifecycle rule)
  probe-immutability <container>       try to set a blob immutability policy / legal hold
Account names and keys come from AZ_<A|B>_ACCOUNT / AZ_<A|B>_KEY / AZ_<A|B>_HOST.
"""
import datetime as dt
import os
import sys

from azure.core.exceptions import HttpResponseError, ResourceExistsError
from azure.storage.blob import (BlobServiceClient, ContainerSasPermissions,
                                ImmutabilityPolicy, generate_container_sas)

CA = os.environ.get("AZ_CA", "/certs/ca.crt")


def svc(side):
    acct = os.environ[f"AZ_{side}_ACCOUNT"]
    key = os.environ[f"AZ_{side}_KEY"]
    host = os.environ[f"AZ_{side}_HOST"]
    url = f"https://{host}:10000/{acct}"
    return acct, key, BlobServiceClient(url, credential={"account_name": acct, "account_key": key},
                                        connection_verify=CA)


def main(argv):
    side, cmd, *args = argv
    acct, key, s = svc(side)
    if cmd == "mk":
        try:
            s.create_container(args[0])
            print(f"created {acct}/{args[0]}")
        except ResourceExistsError:
            print(f"exists {acct}/{args[0]}")
    elif cmd == "sas":
        hours = int(args[2]) if len(args) > 2 else 24
        tok = generate_container_sas(acct, args[0], account_key=key,
                                     permission=ContainerSasPermissions.from_string(args[1]),
                                     expiry=dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=hours))
        print(tok)
    elif cmd in ("ls", "count"):
        c = s.get_container_client(args[0])
        blobs = list(c.list_blobs(name_starts_with=args[1] if len(args) > 1 else None))
        if cmd == "ls":
            for b in blobs:
                print(f"{b.size:>10}  {b.name}")
        print(f"# {len(blobs)} blobs, {sum(b.size for b in blobs)} bytes")
    elif cmd == "rm":
        c = s.get_container_client(args[0])
        names = [b.name for b in c.list_blobs(name_starts_with=args[1])]
        for n in names:
            c.delete_blob(n)
        print(f"deleted {len(names)} blobs under {args[0]}/{args[1]}")
    elif cmd == "probe-immutability":
        b = s.get_container_client(args[0]).get_blob_client("immutability-probe")
        b.upload_blob(b"x", overwrite=True)
        for name, fn in (("set_immutability_policy", lambda: b.set_immutability_policy(
                ImmutabilityPolicy(expiry_time=dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1),
                                   policy_mode="Unlocked"))),
                         ("set_legal_hold", lambda: b.set_legal_hold(True))):
            try:
                fn()
                print(f"{name}: accepted")
            except HttpResponseError as e:
                print(f"{name}: HTTP {e.status_code} {getattr(e, 'error_code', None) or e.reason}")
        b.delete_blob()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
