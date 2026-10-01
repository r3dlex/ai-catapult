"""Exercise shipped public wrappers, never import their validator directly."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--skills-root', required=True)
parser.add_argument('--fixture-source', required=True)
parser.add_argument('--repo-root', required=True)
args = parser.parse_args()
sys.path.insert(0, str(Path(args.fixture_source) / 'tests'))
from readiness_fixture import fixture, write, digest

source = Path(args.skills_root)
if (source / '04-validate-handoff/autobahn').is_dir():
    auto = source / '04-validate-handoff/autobahn'
    north = source / '02-govern-plan/northstar'
else:
    auto = source / 'skills/autobahn'
    north = source / 'skills/northstar'
results = {}


def call(script, *argv):
    return subprocess.run(['bash', str(script), *map(str, argv)], capture_output=True, text=True, timeout=20)


def verdict(name, result, success):
    assert (result.returncode == 0) == success, (name, result.stdout, result.stderr)
    dependency_case = (name.startswith('missing-') and name != 'missing-fixture') or name.startswith('mixed-')
    if dependency_case:
        assert 'dependency_failed' in result.stdout + result.stderr, (name, result.stdout, result.stderr)
    if name == 'blocked-direct':
        assert 'goal_not_ready' in result.stdout, result.stdout
    if name == 'no-selection':
        assert 'selection_required' in result.stdout, result.stdout
    if name == 'legacy-direct-no-fallback':
        assert 'migration_required:direct-goal/1' in result.stdout, result.stdout
    if name == 'missing-fixture':
        assert 'gate_failed' in result.stdout and 'fixture-proof:' in result.stdout, result.stdout
    results[name] = {'verdict': 'accepted' if success else 'rejected'}
    if not dependency_case:
        report = json.loads(result.stdout)
        results[name]['report'] = report
    if success:
        report = json.loads(result.stdout)
        if 'plan_id' in report:
            assert report['plan_id'] == 'chosen', report
            assert report['repository'] == {'id': 'fixture', 'root': str(root.resolve())}, report
            assert report['goals'] == ['G1'], report
            assert report['specification'] == bundle['spec'], report
            assert report['handoff'] == entry, report
    return result


with tempfile.TemporaryDirectory(prefix='readiness-public-') as tmp:
    root = Path(args.repo_root).resolve()
    assert root.is_dir() and not any(root.iterdir()), 'caller must supply an empty owned temporary repo'
    bundle, context = fixture(root)
    published = verdict('publish', call(north / 'handoff-write.sh', '--root', root, '--bundle', root / 'plan.json'), True)
    entry = json.loads(published.stdout)['published']
    context['authority']['subject_sha256'] = entry['artifacts']['bundle']['sha256']
    write(root, 'context.json', context)
    selected = ['--root', root, '--handoff', entry['id'], '--goal-id', 'G1', '--context', root / 'context.json']
    verdict('exact', call(auto / 'prereq-check.sh', *selected), True)
    planning = verdict('planning-without-context', call(auto / 'prereq-check.sh', *selected[:-2], '--stage', 'planning'), True)
    report = json.loads(planning.stdout)
    assert not report['execution_ready'] and not report['dispatch_authorized'], report
    assert set(report['per_goal']['G1']) == {'preparation', 'implementation', 'merge'}, report
    assert all(v['status'] == 'unknown' for v in report['per_goal']['G1'].values()), report
    write(root, '.ai/workflows/repo-workflow.json', {'optional_branches': [{'id': 'northstar-handoff-unrelated', 'status': 'available'}]})
    write(root, '.ai/handoff/northstar-unrelated.md', {})
    verdict('no-selection', call(auto / 'prereq-check.sh', '--root', root), False)
    verdict('unrelated-selection', call(auto / 'prereq-check.sh', '--root', root, '--handoff', 'unrelated', '--goal-id', 'G1', '--context', root / 'context.json'), False)
    verdict('exact-with-unrelated', call(auto / 'prereq-check.sh', *selected), True)
    write(root, 'legacy.json', {'id': 'legacy', 'implementation_ready': True})
    verdict('legacy-direct-no-fallback', call(auto / 'prereq-check.sh', '--root', root, '--goal', root / 'legacy.json'), False)
    blocked = json.loads(json.dumps(bundle))
    blocked['goals'][0]['readiness']['implementation'] = 'blocked'
    write(root, 'blocked.json', {'schema': 'direct-goal/1', 'bundle': blocked})
    context['authority']['subject_sha256'] = digest(root / 'blocked.json')
    write(root, 'context.json', context)
    verdict('blocked-direct', call(auto / 'prereq-check.sh', '--root', root, '--goal', root / 'blocked.json', '--context', root / 'context.json'), False)
    context['authority']['subject_sha256'] = entry['artifacts']['bundle']['sha256']
    write(root, 'context.json', context)
    (root / 'evidence.txt').unlink()
    verdict('missing-fixture', call(auto / 'prereq-check.sh', *selected), False)
    assert not (root / 'SHOULD_NOT_RUN').exists(), 'readiness must never execute verification'
    for missing in ['autobahn', 'northstar']:
        flat = Path(tmp) / ('missing-' + missing)
        flat.mkdir()
        retained = 'northstar' if missing == 'autobahn' else 'autobahn'
        shutil.copytree(north if retained == 'northstar' else auto, flat / retained)
        script = flat / retained / ('handoff-write.sh' if retained == 'northstar' else 'prereq-check.sh')
        argv = ['--root', root, '--bundle', root / 'plan.json'] if retained == 'northstar' else selected
        verdict('missing-' + missing, call(script, *argv), False)
    flat = Path(tmp) / 'mixed'
    for name, path in [('northstar', north), ('autobahn', auto)]:
        shutil.copytree(path, flat / name)
    dependency = flat / 'northstar/readiness-dependency.json'
    data = json.loads(dependency.read_text())
    data['release_fingerprint'] = 'different-release'
    dependency.write_text(json.dumps(data))
    verdict('mixed-producer', call(flat / 'northstar/handoff-write.sh', '--root', root, '--bundle', root / 'plan.json'), False)
    verdict('mixed-consumer', call(flat / 'autobahn/prereq-check.sh', *selected), False)
print(json.dumps(results, sort_keys=True))
