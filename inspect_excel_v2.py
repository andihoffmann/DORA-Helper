import pandas as pd
import re

INPUT_FILE = 'psi_affiliations.xlsx'

try:
    df = pd.read_excel(INPUT_FILE)
    df.columns = df.columns.str.strip()
    
    print("--- COLUMNS ---")
    print(df.columns.tolist())
    
    # Check for missing LASTNAME
    missing_lastname = df[df['LASTNAME'].isna() | (df['LASTNAME'] == '')]
    print(f"\n--- ROWS WITH MISSING LASTNAME: {len(missing_lastname)} ---")
    
    # Check for missing FirstNameInitial
    missing_firstname = df[df['FirstNameInitial'].isna() | (df['FirstNameInitial'] == '')]
    print(f"\n--- ROWS WITH MISSING FirstNameInitial: {len(missing_firstname)} ---")
    
    # Check for Year extraction failure
    def has_year(val):
        if pd.isna(val): return False
        return bool(re.search(r'(\d{4})', str(val)))
        
    df['has_year'] = df['Source'].apply(has_year)
    missing_year = df[~df['has_year']]
    
    print(f"\n--- ROWS WITH MISSING/INVALID YEAR IN 'Source': {len(missing_year)} ---")
    if len(missing_year) > 0:
        print("Sample of invalid Source values:")
        print(missing_year['Source'].unique()[:20])
        
    print(f"\nTOTAL ROWS: {len(df)}")
    
except Exception as e:
    print(f"Error: {e}")
