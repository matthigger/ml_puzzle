# The re-run container (see verify.py). Build from this puzzle's folder:
#   docker build -f verify/Dockerfile -t ghost-circuit-verify .
FROM python:3.14-slim
RUN pip install --no-cache-dir numpy scipy pandas scikit-learn matplotlib
ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/mpl
COPY py/ghost_circuit.py py/runner.py verify/child.py /verify/
USER 65534:65534
ENTRYPOINT ["python", "-I", "-B", "/verify/child.py"]
