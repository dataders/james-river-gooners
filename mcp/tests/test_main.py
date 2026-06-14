from unittest.mock import MagicMock, patch

import gooners_mcp.__main__ as main_mod


def test_main_builds_server_and_runs():
    fake_cfg = MagicMock(url="https://p.supabase.co", publishable_key="k",
                         email=None, password=None)
    fake_server = MagicMock()
    with patch.object(main_mod, "load_config", return_value=fake_cfg), \
         patch.object(main_mod, "build_server", return_value=fake_server) as build:
        main_mod.main()
    build.assert_called_once()
    fake_server.run.assert_called_once()
