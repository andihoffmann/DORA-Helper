import pandas as pd
import json
import re

EXCEL_FILE = 'psi_affiliations.xlsx'
JSON_FILE = 'psi_data_2023.js'
AUTHOR_NAME = 'Hemberger'

print(f"Searching for '{AUTHOR_NAME}' in Excel and JSON...")

# 1. Check Excel
try:
    df = pd.read_excel(EXCEL_FILE)
    # Clean checks
    df.columns = df.columns.str.strip()
    
    # Filter for Hemberger
    matches = df[df['LASTNAME'].astype(str).str.contains(AUTHOR_NAME, case=False, na=False)]
    
    print(f"\n--- Excel Matches ({len(matches)}) ---")
    if len(matches) > 0:
        print(matches[['Source', 'LASTNAME', 'FirstNameInitial']].to_string())
        
        # Test the year extraction logic on these rows
        print("\n--- Year Extraction Test ---")
        for idx, row in matches.iterrows():
            source = str(row['Source'])
            match = re.search(r'(\d{4})', source)
            year = match.group(1) if match else "None"
            print(f"Row {idx}: Source='{source}' -> Extracted Year: {year}")
            
    else:
        print("No matches found in Excel!")

except Exception as e:
    print(f"Excel Error: {e}")

# 2. Check JSON
try:
    with open(JSON_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
        json_str = content.split('=', 1)[1].strip()
        data = json.loads(json_str)
    
    found_in_json = False
    for key in data:
        if AUTHOR_NAME.lower() in key.lower():
            print(f"\n--- JSON Match Found: '{key}' ---")
            print(json.dumps(data[key], indent=2))
            found_in_json = True
            
    if not found_in_json:
        print(f"\n--- No matches found in JSON for '{AUTHOR_NAME}' ---")

except Exception as e:
    print(f"JSON Error: {e}")
