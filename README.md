# ErrandRoute
Stop-order planner for a day of errands with opening/closing times. Exact brute force up to 8 stops, labelled multi-start + 2-opt/relocate heuristic beyond, grid estimates or bring-your-own drive-minute matrix. Engine: engine.js. Tests: `node tests/run_tests.js` against an independent Python brute-force oracle (tests/oracle.py).
