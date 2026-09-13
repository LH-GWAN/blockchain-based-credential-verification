import pytest

from dbp_rules.jsonlogic import evaluate


def test_var_and_compare():
    assert evaluate({"<=": [{"var": "a"}, 3]}, {"a": 3}) is True
    assert evaluate({"<": [{"var": "a"}, 3]}, {"a": 3}) is False
    assert evaluate({"==": [{"var": "r.sido"}, "대구광역시"]}, {"r": {"sido": "대구광역시"}}) is True


def test_boolean_only_logic():
    assert evaluate({"and": [True, {"!": [False]}]}, {}) is True
    with pytest.raises(TypeError):
        evaluate({"and": [1, True]}, {})
    with pytest.raises(TypeError):
        evaluate({"if": [1, "a", "b"]}, {})


def test_integer_only_arithmetic():
    assert evaluate({"*": [{"var": "x"}, 100]}, {"x": 7}) == 700
    with pytest.raises(TypeError):
        evaluate({"*": [1.5, 2]}, {})
    with pytest.raises(TypeError):
        evaluate({"<=": ["a", 1]}, {})


def test_unsupported_operator():
    with pytest.raises(ValueError):
        evaluate({"max": [1, 2]}, {})


def test_missing_var_is_none():
    assert evaluate({"var": "nope"}, {}) is None
    assert evaluate({"==": [{"var": "nope"}, None]}, {}) is True
