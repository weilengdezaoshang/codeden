"""Run SWE-bench with an explicit Docker target platform.

The upstream harness leaves Docker's platform unset. That makes Docker request
the host architecture, which is incompatible with SWE-bench's x86_64 images
when the evaluator runs on Apple Silicon.
"""

from __future__ import annotations

import os
import runpy

from docker.models.containers import ContainerCollection
from docker.models.images import ImageCollection


TARGET_PLATFORM = os.environ.get("CODEDEN_SWEBENCH_DOCKER_PLATFORM", "linux/amd64")

_original_create = ContainerCollection.create
_original_pull = ImageCollection.pull


def _create(self, image, command=None, **kwargs):
    kwargs.setdefault("platform", TARGET_PLATFORM)
    return _original_create(self, image, command=command, **kwargs)


def _pull(self, repository, tag=None, all_tags=False, **kwargs):
    kwargs.setdefault("platform", TARGET_PLATFORM)
    return _original_pull(self, repository, tag=tag, all_tags=all_tags, **kwargs)


ContainerCollection.create = _create
ImageCollection.pull = _pull

runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")
