from dbp_ledger import LedgerClient, load_deployment  # noqa: F401


def test_module_imports():
    assert LedgerClient is not None
