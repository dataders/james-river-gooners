def test_package_imports_and_has_version():
    import gooners_mcp
    assert isinstance(gooners_mcp.__version__, str)
    assert gooners_mcp.__version__
