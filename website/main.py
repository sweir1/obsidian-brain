import json, pathlib

def define_env(env):
    pkg = json.loads((pathlib.Path(__file__).parent.parent / "package.json").read_text())
    env.variables["version"] = pkg["version"]
