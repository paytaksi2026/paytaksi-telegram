## DBeaver ilə DB sıfırlama (qısa)

1) DBeaver → connection → **SQL Editor** aç

**Tam sıfır (tövsiyə):**
```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
```

2) `sql/init.sql` faylını DBeaver-də aç və **Run** et.

3) Admin: `0000 / admin1234`
