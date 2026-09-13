import pytest
from dbp_vc import (
    DEFAULT_STATUS_LIST_SIZE,
    VcError,
    create_status_list,
    decode_status_list,
    encode_status_list,
    get_status,
    set_status,
)


def test_default_list():
    lst = create_status_list()
    assert DEFAULT_STATUS_LIST_SIZE == 131072
    assert len(lst) == 16384
    assert not any(lst)
    assert len(create_status_list(64)) == 8
    for bad in (0, -8, 12, 8.5, True):
        with pytest.raises(VcError):
            create_status_list(bad)


def test_bit_layout_msb_first():
    lst = create_status_list(64)
    set_status(lst, 0, True)
    assert lst[0] == 0x80
    set_status(lst, 7, True)
    assert lst[0] == 0x81
    set_status(lst, 8, True)
    assert lst[1] == 0x80
    set_status(lst, 63, True)
    assert lst[7] == 0x01
    assert get_status(lst, 0) and not get_status(lst, 1) and get_status(lst, 7)
    assert get_status(lst, 8) and get_status(lst, 63)
    set_status(lst, 0, False)
    assert lst[0] == 0x01
    assert get_status(lst, 0) is False


@pytest.mark.parametrize("bad", [-1, 64, 1.5, True])
def test_index_range(bad):
    lst = create_status_list(64)
    with pytest.raises(VcError):
        get_status(lst, bad)
    with pytest.raises(VcError):
        set_status(lst, bad, True)


def test_encode_decode_roundtrip():
    lst = create_status_list()
    revoked = [0, 7, 8, 1042, 65535, 131071]
    for i in revoked:
        set_status(lst, i, True)
    encoded = encode_status_list(lst)
    assert encoded.startswith("H4sI")  # gzip magic 1f 8b
    assert not any(c in encoded for c in "+/=")
    assert len(encoded) < 200
    assert encode_status_list(lst) == encoded  # mtime=0 → 결정론적
    decoded = decode_status_list(encoded)
    assert decoded == lst
    revoked_set = set(revoked)
    assert all(get_status(decoded, i) == (i in revoked_set) for i in range(131072))
    assert decode_status_list("u" + encoded) == lst  # multibase 'u' 접두어 허용


def test_rejects_garbage():
    with pytest.raises(VcError):
        decode_status_list("not-gzip")
    with pytest.raises(VcError):
        decode_status_list("@@")
