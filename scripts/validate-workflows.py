import sys, glob, yaml

class StrictLoader(yaml.SafeLoader):
    pass

def no_duplicates(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key: {key!r} (linha {key_node.start_mark.line + 1})", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping

StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, no_duplicates)

ok = True
for path in sorted(glob.glob('.github/workflows/*.yml') + ['docker-compose.yaml']):
    try:
        doc = yaml.load(open(path), Loader=StrictLoader)
        jobs = doc.get('jobs') if isinstance(doc, dict) else None
        extra = f"jobs: {', '.join(jobs)}" if jobs else f"services: {', '.join(doc.get('services', {}))}"
        print(f"✓ {path} — {extra}")
    except Exception as e:
        ok = False
        print(f"✗ {path} — {str(e).strip().splitlines()[-1] if 'duplicate' in str(e) else e}")
sys.exit(0 if ok else 1)
