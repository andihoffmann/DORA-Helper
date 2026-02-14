import pandas as pd
import json

EXCEL_FILE = 'psi_affiliations.xlsx'
JSON_FILE = 'psi_data_2023.js'

try:
    # 1. Count Excel Rows
    df = pd.read_excel(EXCEL_FILE)
    excel_rows = len(df)
    unique_names_excel = df['LASTNAME'].astype(str) + ', ' + df['FirstNameInitial'].astype(str)
    unique_excel_count = unique_names_excel.nunique()
    
    print(f"Excel Rows: {excel_rows}")
    print(f"Unique Names in Excel: {unique_excel_count}")

    # 2. Count JSON Keys
    with open(JSON_FILE, 'r', encoding='utf-8') as f:
        content = f.read()
        # Extract JSON part
        json_str = content.split('=', 1)[1].strip()
        data = json.loads(json_str)
        
    json_keys = len(data)
    total_records = sum(len(records) for records in data.values())
    
    print(f"JSON Keys: {json_keys}")
    print(f"Total Records in JSON: {total_records}")
    
    if total_records < excel_rows:
        print(f"WARNING: {excel_rows - total_records} records missing in JSON!")
    else:
        print("Record counts match (allowing for some duplicates/filtering).")

except Exception as e:
    print(f"Error: {e}")
