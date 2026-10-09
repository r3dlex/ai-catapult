# Serialization vectors

Every writer must turn `serialization-input.json` into bytes equal to
`serialization-expected.json`. Key order is by Unicode **code point** (Python
`sort_keys`): `x_ｚ` (U+FF5A) sorts before `x_😀` (U+1F600). A JavaScript
default `sort()` compares UTF-16 code units and gets this backwards; JS writers
must compare code points. Non-ASCII is written literally (`ensure_ascii=False`).
