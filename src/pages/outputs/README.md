# Running All Scripts

You can now run all analysis scripts with a single command:

## Option 1: Batch file (easiest on Windows)
```bash
run_all_scripts.bat
```
Just double-click the `.bat` file to run all scripts.

## Option 2: PowerShell
```powershell
.\run_all_scripts.ps1
```

## Option 3: Direct Python
```bash
python run_all_scripts.py
```

## Output Locations

- **HTML visualizations**: `outputs/` folder
- **Execution logs**: `outputs/` folder (with `.log` extension)

## Script Output Files

The runner will generate:

- `artist_colistening_network.html` - Artist collaboration network
- `track_transition_graph.html` - Track sequence analysis
- `discovery_comfort_ratio_*.html` - 5 discovery metrics visualizations
- `era_detector_*.html` - 2 listening era analysis visualizations
- `session_vibe_clustering_*.html` - 3 session vibe cluster visualizations
- `skip_prediction_*.html` - 6 skip prediction analysis visualizations

Plus `.log` files for each script showing execution output.

## Features

✅ Runs all scripts sequentially  
✅ Captures all output to logs  
✅ Creates outputs automatically  
✅ Shows summary of successes/failures  
✅ 10-minute timeout per script (configurable in `run_all_scripts.py`)
