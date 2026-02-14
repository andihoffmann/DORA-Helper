import pandas as pd

INPUT_FILE = 'psi_affiliations.xlsx'

try:
    df = pd.read_excel(INPUT_FILE)
    print("Columns:", df.columns.tolist())
    print("\nFirst 5 rows:")
    print(df.head().to_string())
    
    # Check for rows with missing Source or Year
    print("\nRows with missing Source:")
    print(df[df['Source'].isna() | (df['Source'] == '')].head().to_string())
    
except Exception as e:
    print(f"Error reading file: {e}")
