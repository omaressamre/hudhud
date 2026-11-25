# Shared paths for the test scripts. Override with environment variables.
import os
HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.environ.get('HH_EXT', os.path.join(HERE, '..', 'extension'))
HOST = os.environ.get('HH_HOST', '/tmp/hhhost/hudhud-helper')      # built helper (see run-all.sh)
SITE = os.environ.get('HH_SITE', os.path.join(HERE, '.fixtures', 'site'))  # generated media fixtures
SHOTS = os.environ.get('HH_SHOTS', '/tmp/hh-test-shots')
EXT_ID = 'gdcallopdofegjbibhflneideofehmpk'
os.makedirs(SHOTS, exist_ok=True)
