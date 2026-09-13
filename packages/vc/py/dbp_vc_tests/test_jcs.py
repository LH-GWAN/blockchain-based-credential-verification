import pytest
from dbp_vc import VcError, bundle_hash, canonicalize, sha256_hex


def test_sorts_keys_and_removes_whitespace():
    assert canonicalize({"b": 1, "a": [True, None, "x"], "c": {"z": 0, "y": 0}}) == (
        '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}'
    )


def test_key_order_is_code_unit_order():
    assert canonicalize({"b": 0, "a": 0, "B": 0, "_": 0, "0": 0, "가": 0, "": 0}) == (
        '{"":0,"0":0,"B":0,"_":0,"a":0,"b":0,"가":0}'
    )


def test_non_ascii_kept_and_specials_escaped_lowercase():
    assert canonicalize({"k": "대구광역시", "e": 'q"b\\c\n\t\u0001\u001f'}) == (
        '{"e":"q\\"b\\\\c\\n\\t\\u0001\\u001f","k":"대구광역시"}'
    )


def test_scalars_and_empties():
    assert canonicalize(None) == "null"
    assert canonicalize(True) == "true"
    assert canonicalize("s") == '"s"'
    assert canonicalize(9007199254740991) == "9007199254740991"
    assert canonicalize(-42) == "-42"
    assert canonicalize([]) == "[]"
    assert canonicalize({}) == "{}"
    assert canonicalize({"a": {}, "b": ()}) == '{"a":{},"b":[]}'


@pytest.mark.parametrize("bad", [1.5, -0.1, 0.0, float("nan"), float("inf")])
def test_rejects_floats(bad):
    with pytest.raises(VcError) as e:
        canonicalize({"x": bad})
    assert e.value.code == "FLOAT_FORBIDDEN"
    with pytest.raises(VcError):
        canonicalize([bad])


def test_rejects_non_json_types():
    with pytest.raises(VcError):
        canonicalize({"b": b"bytes"})
    with pytest.raises(VcError):
        canonicalize({1: "int key"})
    with pytest.raises(VcError):
        canonicalize({"s": {1, 2}})


def test_insertion_order_independent():
    assert canonicalize({"x": {"b": 1, "a": 2}, "y": 3}) == canonicalize({"y": 3, "x": {"a": 2, "b": 1}})


def test_sha256_vectors():
    assert sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    assert sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    assert sha256_hex(b"abc") == sha256_hex("abc")


def test_bundle_hash():
    obj = {"rules": {"ageOver65": {">=": [{"var": "age"}, 65]}}, "version": "2026.1"}
    assert bundle_hash(obj) == "0x" + sha256_hex(canonicalize(obj))
    assert len(bundle_hash(obj)) == 66
    assert bundle_hash({"version": "2026.1", "rules": {"ageOver65": {">=": [{"var": "age"}, 65]}}}) == bundle_hash(obj)
